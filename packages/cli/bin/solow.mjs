#!/usr/bin/env node
/**
 * `npx solow` — bring the whole SoloW stack up on a machine that has nothing installed but Node.
 *
 * Three services, the same three `scripts/start.sh` runs in the repo:
 *   - web app (Next.js SPA + tRPC API)  → http://localhost:5000
 *   - orchestrator (WS hub, /events, /api/inngest)  → http://localhost:5001
 *   - Inngest Dev Server (the durable engine)       → http://localhost:8288
 *
 * Why this file is Node and not Bun: `npx` runs whatever `bin` resolves to under the Node that
 * invoked it, so the entry point cannot assume Bun exists. It resolves the `bun` binary that
 * npm installed as a dependency and re-launches the real services under it — the app needs Bun
 * at runtime for `bun:sqlite` (Decision 0008), but the user never has to know that.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const DEFAULTS = { web: 5000, ws: 5001, inngest: 8288 };

// ---------------------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {
    webPort: DEFAULTS.web,
    wsPort: DEFAULTS.ws,
    inngestPort: DEFAULTS.inngest,
    dataDir: process.env.SOLOW_HOME || join(homedir(), ".solow"),
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "-v":
      case "--version":
        console.log(pkg.version);
        process.exit(0);
        break;
      case "-p":
      case "--port":
        opts.webPort = port(next(), arg);
        break;
      case "--ws-port":
        opts.wsPort = port(next(), arg);
        break;
      case "--inngest-port":
        opts.inngestPort = port(next(), arg);
        break;
      case "--data-dir":
        opts.dataDir = resolve(next());
        break;
      case "--no-open":
        opts.open = false;
        break;
      default:
        fail(`unknown option: ${arg}\nRun \`solow --help\` for the list.`);
    }
  }
  return opts;
}

function port(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    fail(`${flag} expects a port 1-65535, got "${value}"`);
  return n;
}

function usage() {
  console.log(`
  solow ${pkg.version} — Solo Workflow

  Usage
    npx solow [options]

  Options
    -p, --port <n>        Port for the web UI          (default ${DEFAULTS.web})
        --ws-port <n>     Port for the orchestrator    (default ${DEFAULTS.ws})
        --inngest-port <n>  Port for the Inngest engine  (default ${DEFAULTS.inngest})
        --data-dir <path> Where the database, worktrees and repo cache live
                          (default ~/.solow, or $SOLOW_HOME)
        --no-open         Do not open a browser on start
    -h, --help            Show this message
    -v, --version         Print the version

  On first run this creates the database, applies migrations, seeds a workspace and
  generates the encryption keys — all under the data directory. Nothing leaves the machine.
`);
}

function fail(message) {
  console.error(`solow: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------- vendored binaries

/**
 * Is this a real native executable, or the placeholder its package ships instead?
 *
 * `bun` and `inngest-cli` both publish a small text placeholder at the binary's path and
 * download the real, platform-specific executable in a postinstall hook. npm 11.19 and newer
 * **block install scripts by default**, so on a current npm both placeholders survive the
 * install and the first thing a user sees is the placeholder's own error — "Inngest CLI binary
 * not found" (reported 2026-08-28).
 *
 * Checked by magic number rather than by size or name: a real executable is ELF (Linux), Mach-O
 * (macOS, including the universal wrapper) or PE (Windows), and every placeholder here is a text
 * script. `existsSync` cannot tell them apart, which is exactly why the launcher used to spawn a
 * placeholder and let it fail.
 */
function isNativeExecutable(path) {
  let handle;
  try {
    handle = openSync(path, "r");
    const head = Buffer.alloc(4);
    if (readSync(handle, head, 0, 4, 0) < 4) return false;
    const magic = head.readUInt32BE(0);
    return (
      magic === 0x7f454c46 || // ELF
      magic === 0xfeedface || // Mach-O 32, big endian
      magic === 0xcefaedfe || //          32, little endian
      magic === 0xfeedfacf || //          64, big endian
      magic === 0xcffaedfe || //          64, little endian
      magic === 0xcafebabe || //          universal ("fat")
      head.readUInt16BE(0) === 0x4d5a // PE ("MZ")
    );
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * Make sure a dependency's real binary is on disk, running that package's own postinstall if the
 * install skipped it.
 *
 * Doing it here rather than telling the user to reinstall with a flag: the package they ran is
 * the one that knows it needs these, the download is the dependency's own published script, and
 * "npx it and it works" is the whole promise of shipping this as a CLI. It runs at most once —
 * the script writes the real executable into `node_modules`, where the next start finds it.
 */
function ensureNativeBinary({ binary, packageDir, script, label }) {
  if (existsSync(binary) && isNativeExecutable(binary)) return binary;

  const installer = join(packageDir, script);
  if (!existsSync(installer)) return null;

  console.log(`solow: fetching the ${label} binary (its install step was skipped)…`);
  const result = spawnSync(process.execPath, [installer], {
    cwd: packageDir,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) return null;
  return existsSync(binary) && isNativeExecutable(binary) ? binary : null;
}

// ---------------------------------------------------------------------------- bun

/**
 * The `bun` npm package is a real dependency, so in the normal `npx` case this resolves inside
 * our own node_modules and the user needs nothing preinstalled. A Bun already on PATH is
 * preferred when present: it is the one the user maintains, and reusing it skips a second copy.
 */
function resolveBun() {
  const onPath = spawnSync("bun", ["--version"], { stdio: "ignore", shell: false });
  if (onPath.status === 0) return "bun";
  try {
    const packageDir = dirname(require.resolve("bun/package.json"));
    const bin = ensureNativeBinary({
      binary: join(packageDir, "bin", "bun.exe"),
      packageDir,
      script: "install.js",
      label: "Bun",
    });
    if (bin) return bin;
  } catch {
    // fall through to the error below
  }
  fail(
    "could not find a Bun runtime.\n" +
      "  The `bun` package installs one, but its download step did not run and could not be\n" +
      "  re-run here. Install Bun yourself and retry:\n" +
      "    curl -fsSL https://bun.sh/install | bash",
  );
}

/** The Inngest Dev Server binary, named `.exe` only on Windows. */
function resolveInngest() {
  const packageDir = dirname(require.resolve("inngest-cli/package.json"));
  const bin = ensureNativeBinary({
    binary: join(packageDir, "bin", process.platform === "win32" ? "inngest.exe" : "inngest"),
    packageDir,
    script: "postinstall.js",
    label: "Inngest Dev Server",
  });
  if (!bin) {
    fail(
      "the Inngest Dev Server binary is missing, and downloading it here did not work.\n" +
        "  `inngest-cli` fetches it in a postinstall hook, which recent npm versions skip by\n" +
        "  default. Re-run the install allowing that hook:\n" +
        "    npm rebuild --ignore-scripts=false inngest-cli",
    );
  }
  return bin;
}

// ---------------------------------------------------------------------------- state

/**
 * Secrets are generated once and persisted, not derived per run: the database encrypts stored
 * provider tokens with `SOLOW_SECRET_KEY`, so a key that changed between runs would leave every
 * previously stored secret undecryptable. Written 0600 — they are the keys to that data.
 */
function secret(dataDir, name, make) {
  const file = join(dataDir, name);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const value = make();
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

function buildEnv(opts) {
  mkdirSync(opts.dataDir, { recursive: true });
  return {
    ...process.env,
    NODE_ENV: "production",
    SOLOW_DB_DRIVER: "sqlite",
    SOLOW_SQLITE_PATH: join(opts.dataDir, "solow.db"),
    SOLOW_SECRET_KEY: secret(opts.dataDir, "secret.key", () => randomBytes(32).toString("base64")),
    SOLOW_AUTH_SECRET: secret(opts.dataDir, "auth.secret", () =>
      randomBytes(32).toString("base64"),
    ),
    SOLOW_STREAM_SECRET: secret(opts.dataDir, "stream.secret", () =>
      randomBytes(32).toString("base64"),
    ),
    SOLOW_WORKTREE_ROOT: join(opts.dataDir, "worktrees"),
    SOLOW_REPO_CACHE_ROOT: join(opts.dataDir, "repos"),
    SOLOW_WS_PORT: String(opts.wsPort),
    SOLOW_WS_URL: `ws://localhost:${opts.wsPort}`,
    SOLOW_WEB_URL: `http://localhost:${opts.webPort}`,
    SOLOW_ORCHESTRATOR_URL: `http://localhost:${opts.wsPort}`,
    SOLOW_INNGEST_PORT: String(opts.inngestPort),
    // Single-user local install: there is one person at this machine and they own it, so the
    // stack binds them to the seeded workspace instead of asking them to invent an account.
    SOLOW_DEV_OWNER: process.env.SOLOW_DEV_OWNER ?? "on",
    SOLOW_AGENT_COMMAND: process.env.SOLOW_AGENT_COMMAND ?? "claude",
    // Inngest's own variable: a URL points the SDK at the local Dev Server below rather than
    // Inngest Cloud. Spelled out rather than left as "1", which falls back to the SDK's
    // hardcoded :8288 and silently breaks registration whenever the port is overridden.
    INNGEST_DEV: `http://localhost:${opts.inngestPort}`,
  };
}

// ---------------------------------------------------------------------------- ports

function portFree(p) {
  return new Promise((res) => {
    const socket = createConnection({ port: p, host: "127.0.0.1" });
    const done = (free) => {
      socket.destroy();
      res(free);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(600, () => done(true));
  });
}

async function waitForPort(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portFree(p))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------------------------------------------------------------------------- run

const children = [];
let shuttingDown = false;

function start(name, bin, args, env, extra = {}) {
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], ...extra });
  const tag = `[${name}]`;
  const relay = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(`${tag} ${line}\n`);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`\nsolow: ${name} exited (${signal ?? `code ${code}`}) — stopping the rest.`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  // Give them a moment to close listeners, then make sure the process actually ends.
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 2000).unref();
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    // A machine with no browser (a server, a container) is a normal way to run this.
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bun = resolveBun();
  const env = buildEnv(opts);

  for (const [label, p] of [
    ["web", opts.webPort],
    ["orchestrator", opts.wsPort],
    ["inngest", opts.inngestPort],
  ]) {
    if (!(await portFree(p))) {
      fail(`port ${p} (${label}) is already in use — free it or pass a different port.`);
    }
  }

  // Migrations run on every start, not just the first: drizzle skips the ones already recorded,
  // so it is cheap, and without it an upgraded `npx solow` would open an old database and 500 on
  // tables that do not exist yet. Seeding stays first-run only.
  const fresh = !existsSync(env.SOLOW_SQLITE_PATH);
  console.log(`solow ${pkg.version}  ·  data ${opts.dataDir}`);
  console.log(fresh ? "initializing database…" : "applying migrations…");

  const migrated = spawnSync(bun, [join(DIST, "db", "migrate.js")], { env, stdio: "inherit" });
  if (migrated.status !== 0) fail("migrations failed — see the output above.");
  if (fresh) {
    const seeded = spawnSync(bun, [join(DIST, "db", "seed.js")], { env, stdio: "inherit" });
    if (seeded.status !== 0) fail("seeding failed — see the output above.");
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  start("orchestrator", bun, [join(DIST, "orchestrator", "index.js")], env);

  // Spawned directly, not through Bun: `inngest-cli` ships a native Go executable that its own
  // postinstall drops into `bin/`, so handing the path to a JS runtime would try to parse an ELF
  // header as source. `--persist` keeps queued events and in-flight runs across restarts, which
  // is what stops a run parked at the review gate from being lost when the stack is restarted.
  start(
    "inngest",
    resolveInngest(),
    [
      "dev",
      "--no-discovery",
      "--persist",
      "-u",
      `http://localhost:${opts.wsPort}/api/inngest`,
      "-p",
      String(opts.inngestPort),
    ],
    env,
  );

  // Next's standalone server reads its port and host from the environment; it takes no flags.
  start("web", bun, [join(DIST, "web", "apps", "web", "server.js")], {
    ...env,
    PORT: String(opts.webPort),
    HOSTNAME: "127.0.0.1",
  });

  const url = `http://localhost:${opts.webPort}`;
  if (await waitForPort(opts.webPort, 60_000)) {
    console.log(`\n  SoloW is up → ${url}\n  Ctrl-C to stop.\n`);
    if (opts.open) openBrowser(url);
  } else {
    console.error("solow: the web app did not come up within 60s — see the log above.");
  }
}

main().catch((error) => {
  console.error(`solow: ${error?.stack ?? error}`);
  shutdown(1);
});
