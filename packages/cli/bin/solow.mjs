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
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
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
    npx solow backup  [--out <dir>] [--no-engine] [--data-dir <path>]
    npx solow restore [<backup>] [--data-dir <path>]   (lists backups without <backup>)
    npx solow executor-image [--tag <name>]            (needs Docker; see below)

  Options
    -p, --port <n>        Port for the web UI          (default ${DEFAULTS.web})
        --ws-port <n>     Port for the orchestrator    (default ${DEFAULTS.ws})
        --inngest-port <n>  Port for the Inngest engine  (default ${DEFAULTS.inngest})
        --data-dir <path> Where the database, worktrees and repo cache live
                          (default ~/.solow, or $SOLOW_HOME)
        --no-open         Do not open a browser on start
    -h, --help            Show this message
    -v, --version         Print the version

  Environment
    SOLOW_HOME            Same as --data-dir
    SOLOW_FETCH_BINARIES  Set to 1 to let this command download the Bun and Inngest
                          binaries when your npm skipped their install hooks. Off by
                          default: starting the app never fetches anything on its own.
    SOLOW_BIND_HOST       Interface the web app, orchestrator and Inngest listen on
                          (default 127.0.0.1, this machine only). Set it to 0.0.0.0 to reach
                          SoloW from the network; a warning is printed.
    SOLOW_DEV_OWNER       Set to on to skip sign-in (development only; refused together with
                          a non-loopback SOLOW_BIND_HOST).

  On first run this creates the database, applies migrations, creates your workspace and
  generates the encryption keys — all under the data directory. Nothing leaves the machine.
  Before an upgrade changes the database, a copy of it and its keys is kept in
  <data-dir>/backups. \`backup\` works while SoloW runs; \`restore\` needs it stopped.

  \`executor-image\` builds ${DEFAULT_EXECUTOR_IMAGE} (or $SOLOW_EXECUTOR_IMAGE), the image with
  Claude Code and opencode in it. Once it exists, the guided setup runs Claude in an isolated
  container on this machine instead of directly as you.
`);
}

function fail(message) {
  console.error(`solow: ${message}`);
  process.exit(1);
}

/**
 * Is `git` on the PATH, and usable?
 *
 * Checked at start-up rather than left to the first Task, because that is the difference between
 * a sentence someone can act on and a failure buried in a harness run: every Repository is cloned
 * with `git`, and every Task's worktree is a `git worktree add`. Without it nothing that makes
 * this a product works, but the web UI comes up perfectly, so the person who is missing it finds
 * out at the least convenient moment and with the least legible error.
 *
 * `--version` rather than `command -v`: a `git` that is on the PATH but cannot execute — a broken
 * shim, an unsatisfied dynamic link, a Windows Store stub — passes the lookup and fails the run,
 * and this whole check exists to move that discovery earlier.
 */
function gitUsable() {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
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
 * Whether the launcher may fetch a missing binary itself. **Off unless asked for.**
 *
 * `bun` and `inngest-cli` both download their real executable from a third party
 * (`cli.inngest.com`, `github.com/inngest/inngest/releases`) in a postinstall hook. When npm
 * skips that hook the binary is a placeholder, and this launcher briefly did the download itself
 * at startup — which meant `npx` reached out to GitHub without being asked. Starting a program
 * should not fetch a hundred megabytes from a third party as a side effect, so the default is now
 * to stop and say what to install; set `SOLOW_FETCH_BINARIES=1` to opt back in.
 */
const MAY_FETCH_BINARIES = process.env.SOLOW_FETCH_BINARIES === "1";

/**
 * The real binary for a vendored dependency, or null when only its placeholder is on disk.
 *
 * Both packages publish a small text placeholder where the executable goes, so `existsSync` says
 * yes to something that is not a binary — the check has to be what the file *is*.
 */
function vendoredBinary({ binary, packageDir, script, label }) {
  if (existsSync(binary) && isNativeExecutable(binary)) return binary;

  const installer = join(packageDir, script);
  if (!existsSync(installer) || !MAY_FETCH_BINARIES) return null;

  console.log(`solow: fetching the ${label} binary (SOLOW_FETCH_BINARIES=1)…`);
  const result = spawnSync(process.execPath, [installer], {
    cwd: packageDir,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) return null;
  return existsSync(binary) && isNativeExecutable(binary) ? binary : null;
}

/** Is this command on PATH and runnable? */
function onPath(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore", shell: false }).status === 0;
}

// ---------------------------------------------------------------------------- bun

/**
 * Where Bun's real binary actually comes from: `@oven/bun-<platform>`, an optional dependency of
 * the `bun` package that ships the executable **inside the npm tarball**.
 *
 * This is the one that matters for a restricted or airgapped install: nothing is downloaded, the
 * binary arrives from the registry like any other package, and `bun`'s own postinstall only
 * copies it into place — so skipping that hook costs nothing as long as we look here instead of
 * at the placeholder it would have overwritten.
 *
 * npm installs only the entry matching the host, so the list is candidates, not a guess: on Linux
 * the glibc and musl builds are both plausible and whichever was installed is the right one.
 */
function ovenBunPackages() {
  const cpu = process.arch === "arm64" ? "aarch64" : process.arch;
  switch (process.platform) {
    case "linux":
      return [`@oven/bun-linux-${cpu}`, `@oven/bun-linux-${cpu}-musl`];
    case "darwin":
      return [`@oven/bun-darwin-${cpu}`];
    case "win32":
      return [`@oven/bun-windows-${cpu}`];
    case "freebsd":
      return [`@oven/bun-freebsd-${cpu}`];
    default:
      return [];
  }
}

/**
 * The `bun` npm package is a real dependency, so in the normal `npx` case this resolves inside
 * our own node_modules and the user needs nothing preinstalled. A Bun already on PATH is
 * preferred when present: it is the one the user maintains, and reusing it skips a second copy.
 */
function resolveBun() {
  if (onPath("bun")) return "bun";

  // Straight from the registry, before anything that might want to download (see above).
  for (const name of ovenBunPackages()) {
    try {
      const dir = dirname(require.resolve(`${name}/package.json`));
      for (const file of ["bun", "bun.exe"]) {
        const candidate = join(dir, "bin", file);
        if (existsSync(candidate) && isNativeExecutable(candidate)) return candidate;
      }
    } catch {
      // not the platform npm installed — try the next candidate
    }
  }

  try {
    const packageDir = dirname(require.resolve("bun/package.json"));
    const bin = vendoredBinary({
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
      "  The bundled `bun` package ships a placeholder and downloads the real binary in an\n" +
      "  install hook your npm skipped. Install Bun once, then re-run:\n" +
      "    curl -fsSL https://bun.sh/install | bash\n" +
      "  Or let this command fetch it for you:  SOLOW_FETCH_BINARIES=1",
  );
}

/**
 * Where the Inngest Dev Server binary comes from here: `@satcomx00-x00/solow-inngest-<platform>`,
 * an optional dependency that carries the executable **inside its npm tarball**.
 *
 * Upstream's `inngest-cli` ships a placeholder and downloads the real binary from
 * `cli.inngest.com` (GitHub as fallback) in a postinstall hook, and no per-platform package
 * exists on npm — not from Inngest, not from anyone. That makes it unusable on an npm that
 * blocks install scripts, and impossible in an airgapped or npm-only environment. So SoloW
 * republishes it, one package per platform, the same way Bun distributes `@oven/bun-*`
 * (user decision, 2026-08-28). npm installs only the one matching the host, from the registry,
 * with no script and no network beyond npm itself.
 *
 * See `scripts/build-inngest-packages.ts` for how they are produced, and for the licensing note.
 */
function vendoredInngestPackage() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `@satcomx00-x00/solow-inngest-${os}-${process.arch}`;
}

/**
 * The Inngest Dev Server binary — an `inngest` already on PATH first.
 *
 * PATH takes precedence for the same reason it does for Bun: it is the copy the user installed
 * and maintains. Note the package name — `inngest` on npm is the JavaScript SDK and ships no
 * executable at all; the Dev Server lives only in `inngest-cli`.
 */
function resolveInngest() {
  if (onPath("inngest")) return "inngest";

  // From the registry, before anything that might want to download (see above).
  try {
    const dir = dirname(require.resolve(`${vendoredInngestPackage()}/package.json`));
    for (const file of ["inngest", "inngest.exe"]) {
      const candidate = join(dir, "bin", file);
      if (existsSync(candidate) && isNativeExecutable(candidate)) return candidate;
    }
  } catch {
    // no package for this platform — fall through
  }

  try {
    const packageDir = dirname(require.resolve("inngest-cli/package.json"));
    const bin = vendoredBinary({
      binary: join(packageDir, "bin", process.platform === "win32" ? "inngest.exe" : "inngest"),
      packageDir,
      script: "postinstall.js",
      label: "Inngest Dev Server",
    });
    if (bin) return bin;
  } catch {
    // fall through to the error below
  }
  fail(
    "could not find the Inngest Dev Server.\n" +
      `  It normally arrives with \`${vendoredInngestPackage()}\`, installed from npm\n` +
      "  alongside this package. If your install skipped optional dependencies, or there is no\n" +
      "  build for this platform, install one yourself and re-run:\n" +
      `    npm i ${vendoredInngestPackage()}\n` +
      "    npm i -g inngest-cli    (downloads from cli.inngest.com — not for an airgap)\n" +
      "  (`inngest` is the SDK and has no binary — the Dev Server is `inngest-cli`.)",
  );
}

// ---------------------------------------------------------------------------- state

/**
 * Secrets are generated once and persisted, not derived per run: the database encrypts stored
 * provider tokens with `SOLOW_SECRET_KEY`, so a key that changed between runs would leave every
 * previously stored secret undecryptable. Written 0600 — they are the keys to that data.
 *
 * An exported value wins, as it does in `scripts/lib/engine-env.sh`: a deployment that manages
 * its own secrets must not have them silently replaced by the files.
 *
 * An empty file, which an interrupted first run or a full disk leaves, is no key and is replaced —
 * the same `[ -s ]` rule as the shell launchers. Read as it was, it set an empty key.
 */
function secret(dataDir, name, make, envName) {
  const exported = process.env[envName];
  if (exported) return exported;
  const file = join(dataDir, name);
  if (existsSync(file) && statSync(file).size > 0) return readFileSync(file, "utf8").trim();
  const value = make();
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  // The mode above only applies to a file this call creates, not to the empty one it replaced.
  chmodSync(file, 0o600);
  return value;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** The interface every service listens on. Network exposure is a choice, so it is named once. */
function bindHost() {
  return process.env.SOLOW_BIND_HOST || "127.0.0.1";
}

/**
 * Where the services reach each other. Not `localhost`, which can resolve to ::1 while they listen
 * on 127.0.0.1, and which a specific LAN bind address is not listening on at all. A wildcard bind
 * is reachable on loopback. Same rule as `scripts/lib/engine-env.sh`.
 */
function internalHost() {
  const host = bindHost();
  if (host === "0.0.0.0" || host === "::" || host === "localhost") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** Called once at start: says out loud what leaving the machine means, and refuses the worst case. */
function checkExposure() {
  const host = bindHost();
  if (LOOPBACK_HOSTS.has(host) || host.startsWith("127.")) return;
  if (process.env.SOLOW_DEV_OWNER === "on") {
    fail(
      `SOLOW_DEV_OWNER=on with SOLOW_BIND_HOST=${host} would give everyone on the network the Owner's access. Turn one of them off.`,
    );
  }
  console.warn(
    `solow: WARNING: SOLOW_BIND_HOST=${host} exposes SoloW to the network. Anyone who can reach it can try to sign in; put it behind TLS.`,
  );
}

/**
 * The data folder holds the master key and a database with every session token in it, so nobody
 * else on the machine may read any of it — the same rule as `scripts/lib/data-dir.sh`.
 *
 * Created 0700, and an existing one tightened on every start: an earlier version made it 0755 and
 * left the database 0644. Only what SoloW put there — the folder, its keys, its database and the
 * engine's state and backups (copies of both); anything else in it keeps the mode it has. The
 * process umask (set in `main`) covers what is created later, by the services as well.
 */
function prepareDataDir(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    console.warn(`solow: WARNING: could not make ${dataDir} private (chmod 700)`);
  }
  for (const name of readdirSync(dataDir)) {
    if (/\.(key|secret)$/.test(name) || name === "solow.db" || name.startsWith("solow.db-")) {
      makePrivate(join(dataDir, name), false);
    }
  }
  makePrivate(join(dataDir, "inngest"), true);
  makePrivate(join(dataDir, "backups"), true);
}

/** `chmod go=` on a file, or with `recursive` on a whole tree. Symlinks are left alone. */
function makePrivate(path, recursive) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory() && !recursive) return;
    chmodSync(path, stat.mode & 0o700);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) makePrivate(join(path, name), true);
    }
  } catch {
    // Missing, or not ours to change: neither is a reason not to start.
  }
}

function buildEnv(opts) {
  prepareDataDir(opts.dataDir);
  return {
    ...process.env,
    NODE_ENV: "production",
    SOLOW_DB_DRIVER: "sqlite",
    SOLOW_SQLITE_PATH: join(opts.dataDir, "solow.db"),
    SOLOW_SECRET_KEY: secret(
      opts.dataDir,
      "secret.key",
      () => randomBytes(32).toString("base64"),
      "SOLOW_SECRET_KEY",
    ),
    SOLOW_AUTH_SECRET: secret(
      opts.dataDir,
      "auth.secret",
      () => randomBytes(32).toString("base64"),
      "SOLOW_AUTH_SECRET",
    ),
    SOLOW_STREAM_SECRET: secret(
      opts.dataDir,
      "stream.secret",
      () => randomBytes(32).toString("base64"),
      "SOLOW_STREAM_SECRET",
    ),
    SOLOW_WORKTREE_ROOT: join(opts.dataDir, "worktrees"),
    SOLOW_REPO_CACHE_ROOT: join(opts.dataDir, "repos"),
    // Imported Skills. Left unset, the web app put them under whatever directory `npx` ran in.
    SOLOW_SKILLS_ROOT: join(opts.dataDir, "skills"),
    SOLOW_WS_PORT: String(opts.wsPort),
    // The two URLs a browser uses. An exported value wins: behind a LAN address or a proxy the
    // browser's origin is not localhost, and the sign-in check rejects any origin but this one.
    SOLOW_WS_URL: process.env.SOLOW_WS_URL || `ws://localhost:${opts.wsPort}`,
    SOLOW_WEB_URL: process.env.SOLOW_WEB_URL || `http://localhost:${opts.webPort}`,
    SOLOW_ORCHESTRATOR_URL:
      process.env.SOLOW_ORCHESTRATOR_URL || `http://${internalHost()}:${opts.wsPort}`,
    SOLOW_INNGEST_PORT: String(opts.inngestPort),
    // Sign-in is on unless the environment says otherwise: a fresh install asks the person for
    // an Owner account on first visit. The "every visitor is the Owner" stand-in is for
    // development and is opt-in (SOLOW_DEV_OWNER=on), never inherited as a default.
    SOLOW_DEV_OWNER: process.env.SOLOW_DEV_OWNER ?? "off",
    // Loopback unless SOLOW_BIND_HOST names another interface; see bindHost() below.
    SOLOW_BIND_HOST: bindHost(),
    SOLOW_AGENT_COMMAND: process.env.SOLOW_AGENT_COMMAND ?? "claude",
    // Web -> orchestrator bearer secret for /events (B3), and the keys that make the self-hosted
    // engine (`inngest start`) accept only signed requests (F6). Hex because the engine insists.
    SOLOW_ORCHESTRATOR_SECRET: secret(
      opts.dataDir,
      "orchestrator.secret",
      () => randomBytes(32).toString("base64"),
      "SOLOW_ORCHESTRATOR_SECRET",
    ),
    INNGEST_SIGNING_KEY: secret(
      opts.dataDir,
      "inngest-signing.key",
      () => randomBytes(32).toString("hex"),
      "INNGEST_SIGNING_KEY",
    ),
    INNGEST_EVENT_KEY: secret(
      opts.dataDir,
      "inngest-event.key",
      () => randomBytes(32).toString("hex"),
      "INNGEST_EVENT_KEY",
    ),
    // Any INNGEST_DEV (even inherited) would put the SDK in dev mode and skip signature checks;
    // INNGEST_BASE_URL is what points the non-dev SDK at the local engine instead of Cloud.
    INNGEST_BASE_URL: `http://${internalHost()}:${opts.inngestPort}`,
    INNGEST_DEV: undefined,
  };
}

/**
 * Set on the engine's process alone, as scripts/lib/engine-env.sh's `supervise_engine` does.
 * inngest-cli reports its own usage (`cli/command.executed`, then `cli/dev_ui.loaded` in bursts
 * every minute, with a stored device id) through an embedded SDK client that follows
 * INNGEST_EVENT_API_BASE_URL, else INNGEST_BASE_URL, else Inngest Cloud, and has no switch to
 * turn it off (1.46). With INNGEST_BASE_URL it posts them to the engine itself, which rejects
 * Inngest's key in a log line each; without it they leave the machine. Port 0 cannot be connected
 * to, so they fail on the spot. Never in `buildEnv`: the orchestrator's SDK reads the same
 * variable for the events SoloW does send. The update notice is off because the version is the
 * one this package pins, not the user's to bump.
 */
const ENGINE_ONLY_ENV = {
  INNGEST_EVENT_API_BASE_URL: "http://127.0.0.1:0",
  INNGEST_NO_UPDATE_NOTIFIER: "1",
};

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

/** The running process of each service, replaced on every restart. */
const children = new Map();
/** The descriptor the data folder's lock is on (`claimDataDir`), or null without `flock(1)`. */
let dataDirLock = null;
let shuttingDown = false;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The same policy as `scripts/lib/supervise.sh` (FINDINGS F2), and the same variables: a service
 * that exits is started again after 1s, 2s, 4s… up to 30s, while the other two keep running. The
 * count resets once a run has lasted a minute; a service that fails five times in a row is broken
 * rather than unlucky, and only then does the whole stack stop — so a service manager above this
 * one (docs/operations/running-as-a-service.md) sees the failure instead of a stack half up.
 */
const RESTART = {
  limit: envInt("SOLOW_RESTART_LIMIT", 5),
  stableMs: envInt("SOLOW_RESTART_STABLE_SECS", 60) * 1000,
  maxDelayS: envInt("SOLOW_RESTART_MAX_DELAY", 30),
};

function start(name, bin, args, env, extra = {}) {
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
  let failures = 0;
  const launch = () => {
    const startedAt = Date.now();
    // The data folder's lock as the child's fd 3, so it is held for as long as any service runs.
    const stdio = ["ignore", "pipe", "pipe", ...(dataDirLock === null ? [] : [dataDirLock])];
    const child = spawn(bin, args, { env, stdio, ...extra });
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      const how = signal ?? `code ${code}`;
      if (Date.now() - startedAt >= RESTART.stableMs) failures = 0;
      failures += 1;
      if (failures > RESTART.limit) {
        console.error(
          `\nsolow: ${name} exited (${how}) ${RESTART.limit} times in a row — stopping the rest.`,
        );
        shutdown(1);
        return;
      }
      const delay = Math.min(2 ** (failures - 1), RESTART.maxDelayS);
      console.error(
        `\nsolow: ${name} exited (${how}) — restarting in ${delay}s (attempt ${failures} of ${RESTART.limit})`,
      );
      setTimeout(() => {
        if (!shuttingDown) launch();
      }, delay * 1000);
    });
    children.set(name, child);
  };
  launch();
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Set rather than passed only to exit(): if every service is gone before the timer below, Node
  // ends on its own, and would otherwise report success for a stack that failed.
  process.exitCode = code;
  for (const child of children.values()) child.kill("SIGTERM");
  // Give them a moment to close listeners, then make sure the process actually ends.
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
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

/**
 * Marks the data folder as in use while the stack runs (FINDINGS F1). `solow restore` refuses
 * while it is, and a second `solow` on the same folder refuses to start — two stacks on one SQLite
 * file and one engine directory would each run the other's Tasks. Same files and same rule as
 * `scripts/lib/data-dir.sh`.
 *
 * The mark is a flock(2) on `solow.lock`. Node cannot take one, so `flock(1)` takes it on a
 * descriptor this process opened and hands in: the lock belongs to the open file, so it stays
 * after the helper exits. Each service is then given the same descriptor (`start`), so the folder
 * stays locked until the last of them is gone, not just this process — a launcher killed outright
 * leaves its services running, and a pid file naming the launcher could not say so.
 *
 * Returns that descriptor, or null where there is no `flock(1)` (macOS) and a pid file is all
 * there is to go on.
 */
function claimDataDir(dataDir) {
  const lockFd = lockDataDir(dataDir);
  if (lockFd !== null) {
    writePidFile(dataDir);
    return lockFd;
  }
  const file = join(dataDir, "solow.pid");
  if (existsSync(file)) {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
      fail(
        `SoloW is already running on ${dataDir} (pid ${pid}) — stop it first.\n` +
          `  If nothing is running, the pid file is stale: remove ${file}`,
      );
    }
  }
  writePidFile(dataDir);
  return null;
}

/**
 * The data folder's lock alone (see `claimDataDir`): the descriptor it is on, or null where there
 * is no `flock(1)`. Exits if something else holds it.
 */
function lockDataDir(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockFile = join(dataDir, "solow.lock");
  const lockFd = openSync(lockFile, "a", 0o600);
  const locked = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", lockFd] });
  if (locked.error?.code === "ENOENT") {
    closeSync(lockFd);
    return null;
  }
  if (locked.status !== 0) {
    fail(
      `SoloW is already running on ${dataDir} — stop it first.\n` +
        `  Its processes hold ${lockFile}; \`fuser -v ${lockFile}\` lists them.`,
    );
  }
  return lockFd;
}

/** For a person looking at the folder, and the check where there is no `flock(1)`. */
function writePidFile(dataDir) {
  const file = join(dataDir, "solow.pid");
  writeFileSync(file, `${process.pid}\n`);
  process.on("exit", () => {
    try {
      if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
    } catch {
      // already gone
    }
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * `solow backup` and `solow restore`: the same code as the repo's `scripts/backup.sh`, bundled as
 * `dist/db/backup.js` and run under the same Bun as the stack. Neither starts anything.
 */
function runBackupCommand(command, rest) {
  const args = [...rest];
  if (!args.includes("--data-dir")) {
    args.push("--data-dir", process.env.SOLOW_HOME || join(homedir(), ".solow"));
  }
  // A restore replaces the database under anything running on it: refused while a stack holds the
  // data folder's lock, and holding it until done so that no `solow` starts meanwhile. The lock
  // goes to the restore as its fd 3, since Bun cannot take one itself. Without a backup named,
  // `restore` only lists them, which is fine while SoloW runs.
  const stdio = ["inherit", "inherit", "inherit"];
  const env = { ...process.env };
  const at = args.indexOf("--data-dir");
  const named = rest.some((arg, i) => !arg.startsWith("-") && rest[i - 1] !== "--data-dir");
  if (command === "restore" && named) {
    const lockFd = lockDataDir(resolve(args[at + 1] ?? ""));
    if (lockFd !== null) {
      stdio.push(lockFd);
      env.SOLOW_DATA_DIR_LOCKED = "1";
    }
  }
  const result = spawnSync(resolveBun(), [join(DIST, "db", "backup.js"), command, ...args], {
    stdio,
    env,
  });
  process.exit(result.status ?? 1);
}

/**
 * The tag the guided setup looks for — `DEFAULT_EXECUTOR_IMAGE` in `@solow/contracts`, which this
 * file cannot import, so `launcher-executor-image.test.ts` keeps the two spellings in step.
 */
const DEFAULT_EXECUTOR_IMAGE = "solow-executor:local";

/** The package's copy (`scripts/build.ts` puts it in dist/), or the checkout's when run from source. */
function executorDockerfile() {
  const candidates = [
    join(DIST, "executor", "Dockerfile"),
    join(HERE, "..", "..", "..", "docker", "executor", "Dockerfile"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) fail(`the executor image's Dockerfile is missing (looked in ${candidates[0]})`);
  return found;
}

/**
 * `solow executor-image`: build the image the Docker executor runs Claude Code and opencode in
 * (roadmap B4), so the guided setup can put Claude in a container instead of on this machine.
 *
 * Here rather than only in the repo's Makefile because the person who needs it most installed
 * SoloW with npx and has no checkout. The same code serves both: `make executor-image` runs this.
 * The Dockerfile goes in on stdin with no build context, so nothing from the machine can be copied
 * into a layer. `SOLOW_EXECUTOR_IMAGE` and `SOLOW_DOCKER_BIN` are the orchestrator's own settings,
 * read here too, so the tag built is the one the setup asks the daemon for.
 */
function runExecutorImageCommand(rest) {
  let tag = process.env.SOLOW_EXECUTOR_IMAGE || DEFAULT_EXECUTOR_IMAGE;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--tag" && rest[i + 1]) tag = rest[++i];
    else
      fail(
        `unknown option for executor-image: ${rest[i]}\nUsage: solow executor-image [--tag <name>]`,
      );
  }
  const docker = process.env.SOLOW_DOCKER_BIN || "docker";

  console.log(`solow: building ${tag} — Claude Code and opencode, for the Docker executor`);
  const built = spawnSync(docker, ["build", "--tag", tag, "-"], {
    input: readFileSync(executorDockerfile()),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (built.error) {
    fail(
      `could not run \`${docker}\` (${built.error.message}).\n` +
        "  The isolated executor needs Docker on this machine: install it, start it, and re-run.",
    );
  }
  if (built.status !== 0) fail("the image did not build — see the output above.");

  /*
   * Proved the way a Task will use it, not only built: as this user's uid, with `HOME` a tmpfs —
   * the two things the driver always imposes (`runArgs` in `executor/docker.ts`). An image whose
   * harnesses only run as the uid it was built for would pass a plain `docker run` and then fail
   * every Task, so the check is worth the second it costs.
   */
  // `SOLOW_DOCKER_USER` first, as the orchestrator reads it: the uid a Task will actually get.
  const runAs =
    process.env.SOLOW_DOCKER_USER || (process.getuid && `${process.getuid()}:${process.getgid()}`);
  const [uid, gid] = runAs ? runAs.split(":") : [];
  const user = runAs ? ["--user", runAs] : [];
  const owner = runAs ? `,uid=${uid},gid=${gid}` : "";
  const checked = spawnSync(
    docker,
    [
      "run",
      "--rm",
      ...user,
      "--tmpfs",
      `/home/solow:rw,exec,mode=0700${owner},size=64m`,
      "--env",
      "HOME=/home/solow",
      "--entrypoint",
      "/bin/sh",
      tag,
      "-c",
      "claude --version && opencode --version",
    ],
    { stdio: "inherit" },
  );
  if (checked.status !== 0) {
    fail(`${tag} was built, but its harnesses did not run as this user — see the output above.`);
  }
  console.log(
    `\n  ${tag} is ready. Connect Claude in SoloW's setup (again, if you already did) and new` +
      "\n  Tasks run in an isolated container on this machine.\n",
  );
  process.exit(0);
}

async function main() {
  // Before anything is created, and inherited by every service: the database's -wal and -shm, the
  // engine's files and the backups are written by them, long after this file stopped writing.
  process.umask(0o077);
  const [command, ...rest] = process.argv.slice(2);
  if (command === "backup" || command === "restore") runBackupCommand(command, rest);
  if (command === "executor-image") runExecutorImageCommand(rest);
  const opts = parseArgs(process.argv.slice(2));
  const bun = resolveBun();

  if (!gitUsable()) {
    fail(
      "could not run `git`.\n" +
        "  Every Repository is cloned with git, and every Task works in a `git worktree`, so\n" +
        "  solow cannot do anything useful without it. Install it once and re-run:\n" +
        "    macOS          xcode-select --install\n" +
        "    Debian/Ubuntu  sudo apt install git\n" +
        "    Fedora         sudo dnf install git\n" +
        "    Windows        winget install Git.Git",
    );
  }

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
  dataDirLock = claimDataDir(opts.dataDir);

  // Migrations run on every start, not just the first: drizzle skips the ones already recorded,
  // so it is cheap, and without it an upgraded `npx solow` would open an old database and 500 on
  // tables that do not exist yet. Seeding stays first-run only.
  const fresh = !existsSync(env.SOLOW_SQLITE_PATH);
  checkExposure();
  console.log(`solow ${pkg.version}  ·  data ${opts.dataDir}`);
  console.log(fresh ? "initializing database…" : "applying migrations…");

  const migrated = spawnSync(bun, [join(DIST, "db", "migrate.js")], { env, stdio: "inherit" });
  if (migrated.status !== 0) fail("migrations failed — see the output above.");
  // Every start, not only the first: this creates the Workspace and its harness catalog and
  // nothing else, so it is a no-op once they exist — and an install upgraded from a build that
  // never had a catalog gets one rather than a Settings page with an empty harness picker.
  const bootstrapped = spawnSync(bun, [join(DIST, "db", "bootstrap.js")], {
    env,
    stdio: "inherit",
  });
  if (bootstrapped.status !== 0) fail("workspace bootstrap failed — see the output above.");

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
      "start",
      "--sqlite-dir",
      join(opts.dataDir, "inngest"),
      "-u",
      `http://${internalHost()}:${opts.wsPort}/api/inngest`,
      "-p",
      String(opts.inngestPort),
      "--host",
      bindHost(),
    ],
    { ...env, ...ENGINE_ONLY_ENV },
  );

  // Next's standalone server reads its port and host from the environment; it takes no flags.
  start("web", bun, [join(DIST, "web", "apps", "web", "server.js")], {
    ...env,
    PORT: String(opts.webPort),
    HOSTNAME: bindHost(),
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
