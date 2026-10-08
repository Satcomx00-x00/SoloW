/// <reference types="bun-types" />
import { basename, dirname, join, relative } from "node:path";

/**
 * Runs a package's unit tests in batches that fit in memory (FINDINGS C3).
 *
 * One `bun test` over the whole of `apps/web` grew a single process past 4.5 GB and the kernel
 * killed it on a dev box; CI ran the same command on a bigger runner and carried the same risk
 * unseen. The cause was one file (see `ISOLATED`), and the whole suite now peaks under 1 GB in one
 * process — but nothing would have said so when the next leak arrived. So the files are split
 * into batches — one directory at a time, at most `MAX_FILES_PER_BATCH` each —
 * and every batch is its own `bun test` process, so memory is given back between them. The files
 * that are heavy on their own are listed in `ISOLATED` and run alone, with a budget of their own,
 * and a batch that peaks above `PEAK_CEILING_MB` fails even when its tests pass.
 *
 * This is the one way the web tests are run: `apps/web`'s `test` script calls it, so `make test`
 * on a laptop and the Unit tests step in `.github/workflows/verify.yml` run the same batches.
 *
 *   bun run scripts/test-batches.ts [package-dir] [--list] [--only <text>]
 *
 * `package-dir` defaults to the working directory (the package's own `test` script runs it there);
 * `--list` prints the plan and runs nothing; `--only` keeps the batches whose name contains <text>.
 */

export interface Isolated {
  /** Wall-clock budget for this file's process, in seconds. */
  budgetSeconds: number;
  /** `bun test --timeout` for each test of this file, in milliseconds. */
  testTimeoutMs?: number;
}

/**
 * Files that run alone, keyed by path from the repository root: the two that have been the
 * heaviest. Both fit easily now (under 600 MB, under 20 s) — the 8 GB, three-minute run of the
 * harness-profiles file was two wrong `toBeNull()` assertions, not the file's size — but each is
 * the first place a regression of that kind would show, and alone it shows under its own name.
 */
export const ISOLATED: Record<string, Isolated> = {
  "apps/web/src/components/features/task/task-workspace.test.tsx": {
    budgetSeconds: 600,
    testTimeoutMs: 30_000,
  },
  "apps/web/src/components/features/settings/harness-profiles-section.test.tsx": {
    budgetSeconds: 600,
    testTimeoutMs: 30_000,
  },
};

/** Enough files to amortise a process's start-up, few enough to stay well under the ceiling. */
export const MAX_FILES_PER_BATCH = 10;
const DEFAULT_BUDGET_SECONDS = 300;
/**
 * A batch that peaks above this fails, though its tests pass. The biggest batch peaks near 750 MB;
 * a GitHub runner has 16 GB and a dev box shares its memory with a running stack. Without a
 * ceiling, "fits in memory" is only true until the next leak, and the first anyone hears of the
 * leak is the kernel killing a run.
 */
export const PEAK_CEILING_MB = 2048;

export interface Batch {
  name: string;
  /** Paths relative to the package directory, each starting with `./` so bun reads them as paths. */
  files: string[];
  budgetSeconds: number;
  testTimeoutMs?: number;
}

/**
 * The batches for a package's test files.
 *
 * @param pkgFromRoot the package directory relative to the repository root (`apps/web`)
 * @param files the test files relative to the package directory
 */
export function planBatches(pkgFromRoot: string, files: string[]): Batch[] {
  const batches: Batch[] = [];
  const byDir = new Map<string, string[]>();

  for (const file of [...files].sort()) {
    const isolated = ISOLATED[join(pkgFromRoot, file)];
    if (isolated) {
      batches.push({ name: file, files: [`./${file}`], ...isolated });
      continue;
    }
    const dir = dirname(file);
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }

  for (const [dir, dirFiles] of byDir) {
    // Even chunks — 11 files make 6 + 5, not 10 + a batch of one.
    const chunks = Math.ceil(dirFiles.length / MAX_FILES_PER_BATCH);
    const size = Math.ceil(dirFiles.length / chunks);
    for (let i = 0; i < chunks; i += 1) {
      batches.push({
        name: chunks > 1 ? `${dir} (${i + 1}/${chunks})` : dir,
        files: dirFiles.slice(i * size, (i + 1) * size).map((file) => `./${file}`),
        budgetSeconds: DEFAULT_BUDGET_SECONDS,
      });
    }
  }

  return batches.sort((a, b) => a.name.localeCompare(b.name));
}

export function bunTestArgs(batch: Batch): string[] {
  const args = ["bun", "test", ...batch.files];
  if (batch.testTimeoutMs) args.push("--timeout", String(batch.testTimeoutMs));
  return args;
}

const shellQuote = (arg: string) =>
  /^[\w./=:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

interface Outcome {
  batch: Batch;
  ok: boolean;
  why?: string;
  seconds: number;
  peakMb?: number;
}

async function run(batch: Batch, cwd: string): Promise<Outcome> {
  const started = performance.now();
  const proc = Bun.spawn(bunTestArgs(batch), { cwd, stdio: ["ignore", "inherit", "inherit"] });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, batch.budgetSeconds * 1000);
  const code = await proc.exited;
  clearTimeout(timer);
  const seconds = Math.round((performance.now() - started) / 1000);
  const rss = proc.resourceUsage()?.maxRSS;
  const peakMb = rss ? Math.round(rss / 1024 / 1024) : undefined;
  if (timedOut)
    return { batch, ok: false, why: `over its ${batch.budgetSeconds} s budget`, seconds, peakMb };
  if (code === 0 && peakMb !== undefined && peakMb > PEAK_CEILING_MB) {
    const why = `peaked at ${peakMb} MB, over the ${PEAK_CEILING_MB} MB ceiling`;
    return { batch, ok: false, why, seconds, peakMb };
  }
  if (code === 0) return { batch, ok: true, seconds, peakMb };
  const why =
    proc.signalCode === "SIGKILL" || code === 137
      ? "killed (out of memory?)"
      : `exit ${code ?? proc.signalCode}`;
  return { batch, ok: false, why, seconds, peakMb };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const list = argv.includes("--list");
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined;
  const positional = argv.filter(
    (arg, i) => !arg.startsWith("--") && (onlyAt < 0 || i !== onlyAt + 1),
  );
  const root = join(import.meta.dir, "..");
  const pkg = positional[0] ? join(root, positional[0]) : process.cwd();
  const pkgFromRoot = relative(root, pkg);

  for (const path of Object.keys(ISOLATED)) {
    if (path.startsWith(`${pkgFromRoot}/`) && !(await Bun.file(join(root, path)).exists())) {
      console.error(
        `test-batches: ${path} is listed in ISOLATED but no longer exists — update the list`,
      );
      return 1;
    }
  }

  const files: string[] = [];
  for await (const file of new Bun.Glob("**/*.test.{ts,tsx}").scan({ cwd: pkg })) {
    if (!file.split("/").includes("node_modules")) files.push(file);
  }
  let batches = planBatches(pkgFromRoot, files);
  if (only) batches = batches.filter((batch) => batch.name.includes(only));

  if (list) {
    for (const batch of batches) console.log(`${batch.name}\t${batch.files.length} file(s)`);
    console.log(`${batches.length} batches, ${files.length} test files in ${pkgFromRoot || "."}`);
    return 0;
  }

  const ci = Boolean(process.env.GITHUB_ACTIONS);
  const outcomes: Outcome[] = [];
  for (const [i, batch] of batches.entries()) {
    const title = `batch ${i + 1}/${batches.length}: ${batch.name} (${batch.files.length} file(s))`;
    console.log(ci ? `::group::${title}` : `\n── ${title}`);
    const outcome = await run(batch, pkg);
    if (ci) console.log("::endgroup::");
    outcomes.push(outcome);
  }

  console.log(`\n${basename(pkg)}: ${outcomes.length} batches`);
  for (const { batch, ok, why, seconds, peakMb } of outcomes) {
    const peak = peakMb ? `${peakMb} MB` : "?";
    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${String(seconds).padStart(4)} s  ${peak.padStart(8)}  ${batch.name}${why ? ` — ${why}` : ""}`,
    );
  }
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) return 0;

  console.error(`\n${failed.length} batch(es) failed. Re-run one from ${pkgFromRoot || "."} with:`);
  for (const { batch, why } of failed) {
    const command = bunTestArgs(batch).map(shellQuote).join(" ");
    console.error(`  ${command}`);
    if (ci) console.error(`::error title=Unit tests (${batch.name})::${why} — ${command}`);
  }
  return 1;
}

if (import.meta.main) process.exit(await main());
