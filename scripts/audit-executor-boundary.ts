import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Executor-boundary audit (issue #1 AC-4, issue #96 DoD). Every reach into the execution host —
 * spawning a process, touching the filesystem, shelling out — must go through the `Executor`
 * interface, so a second executor kind (#46 #47 #48) grows one driver instead of a second call
 * site scattered through the app.
 *
 * There are **two** boundaries here and they are not in the same place, which is why the rules
 * below carry a `boundary` rather than sharing one allow-list:
 *
 *   `host`    — `Bun.spawn`, `Bun.file`/`Bun.write`, the Bun shell tag, `node:child_process`.
 *               One file may do this: `apps/orchestrator/src/executor/local.ts`, the driver that
 *               *is* the host. Everything else reaches the host through it.
 *
 *   `docker`  — talking to a Docker daemon at all: the `docker` CLI, its socket, `DOCKER_HOST`,
 *               a client library. The whole of `apps/orchestrator/src/executor/` may do this,
 *               not `docker.ts` alone — `reap.ts` and `preflight.ts` compose `docker` argv
 *               themselves and import only the label constants from `docker.ts`, deliberately
 *               (a reaper that went through the driver would need a Task to reap a container
 *               belonging to a Task that is gone). The unit that owns Docker is the module.
 *
 * The `docker` rules exist because "no direct Docker call outside the driver" only followed
 * *transitively* from the `host` rules, and only for Bun-flavoured host access: `execFile` from
 * `node:child_process`, a `dockerode` dependency, or a `fetch` at `/var/run/docker.sock` would
 * each have reached the daemon with every `host` rule still green.
 *
 * The `docker` rules are written against the argv this repository actually composes, which is not
 * a literal `["docker", …]` anywhere outside `docker.ts`'s own doc comment: `reap.ts` puts
 * `env.SOLOW_DOCKER_BIN` in argv position and `preflight.ts` resolves `opts.dockerBin ?? "docker"`
 * into a local `bin` first. The first version of these rules matched neither, and verbatim copies
 * of both files placed outside the executor module passed the audit — see the fixtures in
 * `audit-executor-boundary.test.ts`, which are those two real files, moved.
 *
 * What these rules still cannot see: `host.exec([bin, "exec", …])` where `bin` arrived as a plain
 * parameter — `claimedByThisOrchestrator(host, bin, name)` in `reap.ts` is written exactly that
 * way. Inside this tree the *caller* is caught instead, because it had to read the binary from
 * somewhere to pass it; what stays invisible is a new file that reads it from an env var of its
 * own naming, names no `solow.` label, and imports no Docker package. That is the residual hole
 * in a textual gate, and the label rule below is the second net under it, not a plug for it.
 *
 * Test files, fixtures, and build/dev scripts are exempt — they stand in for the host in a
 * sandbox, or run at build time, never as part of a live Task.
 */

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["apps", "packages"];

/** The one file allowed to touch the host directly. See `boundary: "host"` above. */
const HOST_DRIVER = "apps/orchestrator/src/executor/local.ts";

/** The module allowed to talk to a Docker daemon. See `boundary: "docker"` above. */
const EXECUTOR_MODULE = "apps/orchestrator/src/executor/";

const EXEMPT_PATTERNS: RegExp[] = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\/testing\.ts$/,
  /\/fixtures\//,
  /\/scripts\//,
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage"]);

type Boundary = "host" | "docker";

/**
 * Subcommands, required *adjacent* to the binary. Adjacency is what separates a call from a list:
 * `["docker", "local"]` is a list of `ExecutorKind`s — `task-run.test.ts` writes exactly that,
 * and `executor-profiles-section.tsx`'s `RUNNABLE_KINDS` is one reorder away — and no
 * `ExecutorKind` ("local", "docker", "ssh", "cloud") is a docker subcommand, so no list of kinds
 * can match here.
 * A gate that cried wolf on a list of kinds would be suppressed, which costs the same as a gate
 * that never fires.
 */
const DOCKER_SUBCOMMAND = [
  "attach",
  "build",
  "commit",
  "compose",
  "container",
  "cp",
  "create",
  "diff",
  "events",
  "exec",
  "export",
  "image",
  "images",
  "import",
  "info",
  "inspect",
  "kill",
  "load",
  "logs",
  "network",
  "pause",
  "port",
  "ps",
  "pull",
  "push",
  "rename",
  "restart",
  "rm",
  "rmi",
  "run",
  "save",
  "start",
  "stats",
  "stop",
  "system",
  "tag",
  "top",
  "unpause",
  "update",
  "version",
  "volume",
  "wait",
].join("|");

/**
 * How a docker binary is named in this tree: the environment variable, the option that carries it,
 * and the shapes a future caller would plausibly reach for. `SOLOW_DOCKER_BIN` on its own is *not*
 * a violation — `env.ts` declares the variable and calls nothing — so every rule below asks for
 * it in a position that is a call: first in an argv array, or defaulted to the `docker` binary.
 */
const DOCKER_BIN_NAME = "SOLOW_DOCKER_BIN|dockerBin|dockerBinary|dockerPath|dockerCommand";

const RULES: Array<{ name: string; pattern: RegExp; boundary: Boundary }> = [
  { name: "Bun.spawn", pattern: /Bun\.spawn\(/, boundary: "host" },
  { name: "Bun.spawnSync", pattern: /Bun\.spawnSync\(/, boundary: "host" },
  { name: "Bun.file", pattern: /Bun\.file\(/, boundary: "host" },
  { name: "Bun.write", pattern: /Bun\.write\(/, boundary: "host" },
  { name: "Bun shell tag ($`...`)", pattern: /\$`/, boundary: "host" },
  {
    name: 'Bun shell import (import { $ } from "bun")',
    pattern: /import\s*\{\s*\$\s*\}\s*from\s*"bun"/,
    boundary: "host",
  },
  {
    // The non-Bun way to do everything the rules above forbid. Nothing in production code
    // imports it today; the rule is what keeps that true, since `execFile("docker", …)` would
    // otherwise satisfy every other rule in this file.
    name: "node:child_process (spawn/exec/execFile)",
    pattern: /["'](?:node:)?child_process["']/,
    boundary: "host",
  },
  {
    // `["docker", "run", …]` — the argv shape `docker.ts` documents, and the one a new call
    // site would most likely copy. A spread second element (`["docker", ...args]`) counts too.
    name: 'docker CLI argv (["docker", "<subcommand>", …])',
    pattern: new RegExp(
      `\\[\\s*(["'\`])docker\\1\\s*,\\s*(?:\\.\\.\\.|(["'\`])(?:${DOCKER_SUBCOMMAND})\\b)`,
    ),
    boundary: "docker",
  },
  {
    // `host.exec([env.SOLOW_DOCKER_BIN, "ps", …])` — how `reap.ts` writes all of its calls. The
    // first element may be a member chain or an index (`process.env["SOLOW_DOCKER_BIN"]`);
    // the character classes carry no comma, so the name has to be in the *first* element.
    name: "docker binary in argv ([…DOCKER_BIN, …])",
    pattern: new RegExp(
      `\\[\\s*[\\w$.\\s"'\\[]{0,80}?(?:${DOCKER_BIN_NAME})\\b[\\w$.\\s"'\\]]{0,20}?,`,
    ),
    boundary: "docker",
  },
  {
    // Reading the configured binary at all: `env.SOLOW_DOCKER_BIN`, `opts.dockerBin`. A member
    // access is what separates a *read* from a *declaration* — `env.ts` writes the name as a Zod
    // key and calls nothing, and a schema field would be the same — so this catches the argv the
    // two rules around it cannot see, the one built from a local copied out of an option.
    name: "docker binary read (env.SOLOW_DOCKER_BIN / opts.dockerBin)",
    pattern: new RegExp(`\\.\\s*(?:${DOCKER_BIN_NAME})\\b`),
    boundary: "docker",
  },
  {
    // `const bin = opts.dockerBin ?? "docker"` — how `preflight.ts` and `docker.ts` start. It is
    // the only line in `preflight.ts` that names Docker at all: its argv is `[bin, ...args]`,
    // which nothing textual can tell from any other argv, so resolving the binary is the step
    // this gate has to catch.
    name: 'docker binary default (dockerBin ?? "docker")',
    pattern: new RegExp(
      `(?:${DOCKER_BIN_NAME})\\b[^\\n]{0,80}?(?:\\?\\?|\\|\\|)\\s*(["'\`])docker\\1`,
    ),
    boundary: "docker",
  },
  {
    // The same call written as a shell string. Anchored on a quote so that prose about `docker
    // run` is not a violation; the subcommand is required so that a sentence beginning "docker"
    // inside a message string is not one either.
    name: 'docker CLI command string ("docker run …")',
    pattern: new RegExp(`(["'\`])docker\\s+(?:${DOCKER_SUBCOMMAND})\\b`),
    boundary: "docker",
  },
  {
    // The labels `docker.ts` stamps on every container it creates. A second net under the argv
    // rules: a caller that composed argv in some shape the patterns above miss still has to name
    // these labels to find a container to act on.
    name: "Docker container label (label=solow.…)",
    pattern: /label=solow\./,
    boundary: "docker",
  },
  {
    // Reaching the daemon without the CLI: a `fetch` at the socket, or an HTTP endpoint taken
    // from the environment. Either one is a Docker client written by hand.
    name: "Docker daemon endpoint (docker.sock / DOCKER_HOST)",
    pattern: /docker\.sock|DOCKER_HOST/,
    boundary: "docker",
  },
  {
    name: "Docker client library import",
    pattern: /["'](?:dockerode|docker-cli-js|node-docker-api|testcontainers|@docker\/[\w-]+)["']/,
    boundary: "docker",
  },
];

/** Production dependencies that are a Docker client. See `boundary: "docker"`. */
const DOCKER_CLIENT_PACKAGES = [
  /^dockerode$/,
  /^@types\/dockerode$/,
  /^docker-cli-js$/,
  /^node-docker-api$/,
  /^testcontainers$/,
  /^@docker\//,
];

function allows(rel: string, boundary: Boundary): boolean {
  return boundary === "host" ? rel === HOST_DRIVER : rel.startsWith(EXECUTOR_MODULE);
}

/** Keywords after which a `/` opens a regex literal rather than dividing. */
const REGEX_MAY_FOLLOW = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Past the closing quote of the string or template literal opening at `start`. */
function endOfQuoted(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      i = endOfTemplateExpression(source, i + 2);
      continue;
    }
    // A `'` or `"` string cannot cross a line, and bailing at the newline is load-bearing rather
    // than tidy: `permission-card.tsx` writes "this deployment's unattended permission policy" as
    // JSX text, and without this the apostrophe opens a string that runs to the end of the file,
    // leaving every comment after it in the haystack. Three files in `apps/web` depend on it.
    if (quote !== "`" && ch === "\n") return i;
    i++;
  }
  return source.length;
}

/** Past the `}` closing the `${…}` whose contents begin at `start`. */
function endOfTemplateExpression(source: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = endOfQuoted(source, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return source.length;
}

/** Past the closing `/` of a regex literal, or `start` if this `/` did not open one. */
function endOfRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return start; // a regex literal does not span lines: this was a division
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i + 1;
    i++;
  }
  return start;
}

/**
 * The file with its comments blanked, so that a rule matches code and not prose.
 *
 * This matters more here than it would in most audits: half of what these files are *about* is
 * Docker, and several of the most careful comments in the repository quote a `docker run` line
 * to explain why the code beneath them is shaped as it is. A gate that fails on the explanation
 * of a rule is a gate somebody deletes.
 *
 * This used to be two regex substitutions, and they were **string-unaware**: the git refspec
 * `"+refs/heads/*:refs/heads/*"` at `worktree/manager.ts:230` opened a pseudo-comment that ran to
 * the next real close-comment token, blanking about thirty lines of live `ensureTaskClone` code
 * — a `Bun.spawn` inserted among them was reported before that change and not after it. So this
 * is a scanner instead: it tracks string, template and regex literals, and a `//` or `/*` inside
 * any of them is text. Comment bodies are blanked *in place*, newlines kept, so line structure
 * survives and removing a comment can never splice two code fragments into a third thing.
 *
 * It errs in one direction only. Everything that is not a comment is emitted verbatim, so a
 * misread — a division taken for a regex, an apostrophe in JSX prose taken for a quote — can at
 * worst leave a comment *unstripped*, which shows up as a false positive a reader can see, and
 * never blank code, which shows up as nothing at all. `${…}` interpolations are copied out whole
 * for the same reason: a comment inside one stays in the haystack.
 */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  let previous = ""; // last significant character emitted
  let word = ""; // identifier run ending at `previous`, for the keyword cases
  while (i < source.length) {
    const ch = source[i] as string;
    const pair = source.slice(i, i + 2);
    if (pair === "//") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (pair === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = endOfQuoted(source, i);
      out += source.slice(i, end);
      previous = ch;
      word = "";
      i = end;
      continue;
    }
    if (ch === "/") {
      const regexOpens =
        word !== ""
          ? REGEX_MAY_FOLLOW.has(word)
          : previous === "" || !/[)\]}\w$"'`]/.test(previous);
      const end = regexOpens ? endOfRegex(source, i) : i;
      if (end > i) {
        out += source.slice(i, end);
        previous = "/";
        word = "";
        i = end;
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) previous = ch;
    word = /[\w$]/.test(ch) ? word + ch : "";
    i++;
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Every workspace `package.json`, plus the root's — a dependency at either is installed here. */
function manifests(root: string): string[] {
  const found = [join(root, "package.json")];
  for (const dir of SCAN_DIRS) {
    for (const entry of readdirSync(join(root, dir))) {
      const manifest = join(root, dir, entry, "package.json");
      try {
        if (statSync(manifest).isFile()) found.push(manifest);
      } catch {
        // Not every directory under `apps/` or `packages/` is a package.
      }
    }
  }
  return found;
}

/**
 * Every boundary violation under `root`, in the order they were found. Takes the root so the tests
 * beside this file can point it at a tree they built — including one holding real files from this
 * repository, moved outside the module that is allowed to own them.
 */
export function auditBoundary(root: string): string[] {
  const violations: string[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file);
      if (EXEMPT_PATTERNS.some((pattern) => pattern.test(rel))) continue;

      const code = withoutComments(readFileSync(file, "utf8"));
      for (const rule of RULES) {
        if (allows(rel, rule.boundary)) continue;
        if (!rule.pattern.test(code)) continue;
        violations.push(
          rule.boundary === "host"
            ? `${rel}: ${rule.name} outside the local executor implementation`
            : `${rel}: ${rule.name} outside ${EXECUTOR_MODULE}`,
        );
      }
    }
  }

  // A dependency, not an import: `dockerode` in a manifest is the step before the call, and the
  // only one a review can still object to cheaply. `dependencies` alone, because a devDependency
  // would be a test's business and tests are exempt from every rule above.
  for (const manifest of manifests(root)) {
    const rel = relative(root, manifest);
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(parsed.dependencies ?? {})) {
      if (DOCKER_CLIENT_PACKAGES.some((pattern) => pattern.test(name))) {
        violations.push(`${rel}: "${name}" is a Docker client dependency`);
      }
    }
  }

  return violations;
}

if (import.meta.main) {
  const violations = auditBoundary(ROOT);
  if (violations.length > 0) {
    console.error("executor-boundary audit FAILED — host or Docker access outside the Executor:\n");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      `\nHost access (spawn, files, shell) belongs in ${HOST_DRIVER}. Talking to a Docker daemon ` +
        `belongs in ${EXECUTOR_MODULE} — the whole module, because reap.ts and preflight.ts compose ` +
        "their own docker argv on purpose; everywhere else reaches the host through an Executor. " +
        "If this genuinely is not agent-execution-host code (a test, fixture, or build script), " +
        "add a narrowly-scoped exemption above with the reason.",
    );
    process.exit(1);
  }

  console.log(
    "executor-boundary audit OK — no host access outside the local driver, no Docker outside the executor module",
  );
}
