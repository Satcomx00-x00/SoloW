import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExecutorConfig } from "@solow/contracts";
import { type StreamTicketClaims, verifyStreamTicket } from "@solow/core/stream";
import type { Db } from "@solow/db";
import { prepareHarnessEnv } from "../billing/guard.js";
import { latestHarnessSessionId, loadTaskRunContext, terminalWorktree } from "../data.js";
import { hasDriver, missingDriverReason } from "../executor/drivers.js";
import type { TerminalExecutor, TerminalExecutorOpts } from "../executor/factory.js";
import type { Executor, TerminalHandle } from "../executor/types.js";
import { profileHarnessConfig } from "../harness/harness-config.js";
import { resolveHarnessConfigEnv } from "../harness/hermetic-home.js";
import type { HarnessRegistry } from "../harness/registry.js";
import { taskExecutorPlacement } from "../inngest/functions/task-run/prepare.js";
import { harnessHomePath, harnessTranscriptsPath } from "../worktree/manager.js";

/**
 * The Task page's terminal: a real shell, on a pseudo-terminal, in the Task's worktree, relayed
 * byte for byte to xterm.js in the browser over its own WebSocket (`/terminal`).
 *
 * **Its own socket, not a frame kind on the Task stream.** The stream is a typed, replayed,
 * JSON log of the *harness's* run; a shell is a person's interactive session — raw bytes both
 * ways, no log, no replay, gone when the window closes. Sharing the hub would have put
 * keystrokes through a schema built for `TaskEvent`s and made every subscriber of the board
 * channel a possible reader of someone's shell. One socket per terminal, authorised by the
 * same short-lived ticket, is the narrower door.
 *
 * **It mounts the Task's conversation.** When the Task has a Claude Code conversation and no run
 * is holding it, the terminal is `claude --resume <that conversation>` — the harness's own TUI,
 * in the worktree, under the same app-owned home, credential, model and settings sources as the
 * run, so it is the very conversation the run had and the next round resumes from whatever is
 * said here. Otherwise it is the person's shell, and says why (`resolveTerminalLaunch`).
 *
 * **It runs where the Task runs** (`startTerminal`). A Docker Task's terminal is a container of
 * its own, on the run's image and mounts; only a local Task's opens on this host. The socket is
 * upgraded first and the place decided after, so that a container that cannot be started — no
 * Docker, no image — reaches the pane as a sentence rather than as a refused upgrade, which a
 * browser cannot read.
 *
 * Wire format: binary frames are terminal bytes (keystrokes up, output down). Text frames are
 * JSON control messages: `{type:"resize",cols,rows}` up; `{type:"mode",mode,reason?}`,
 * `{type:"exit",code}` and `{type:"error",message}` down.
 */

export interface TerminalWsData {
  kind: "terminal";
  claims: StreamTicketClaims;
  cwd: string;
  cols: number;
  rows: number;
  /** What the terminal runs, once `startTerminal` has decided it. */
  launch?: TerminalLaunch | undefined;
  handle?: TerminalHandle | undefined;
  /** Ends wherever the terminal was placed — a container's removal — once there is a place. */
  dispose?: (() => Promise<void>) | undefined;
  /** The window closed: whatever `startTerminal` is still waiting on is no longer wanted. */
  closed?: boolean;
}

/** What the terminal runs: the Task's conversation, or a shell and the reason it is not that. */
export type TerminalLaunch =
  | { mode: "chat"; cmd: string[]; env: Record<string, string> }
  | { mode: "shell"; cmd: string[]; env: Record<string, string>; reason: string };

const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function clampSize(value: string | null, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Authorise a terminal upgrade. The ticket is the stream's — signed by the web API after it
 * checked the session and that the Task is in the caller's Workspace — and it must name a Task:
 * a board ticket opens no shell. The worktree is looked up by the ticket's own Workspace and
 * Task, so a client cannot name a directory.
 */
export async function authorizeTerminal(
  url: string,
  deps: { db: Db; now: () => number; streamSecret: string },
): Promise<{ ok: true; data: TerminalWsData } | { ok: false; status: number; error: string }> {
  const params = new URL(url).searchParams;
  const ticket = params.get("ticket");
  if (!ticket) return { ok: false, status: 401, error: "ticket_required" };
  const verified = verifyStreamTicket(ticket, deps.streamSecret, deps.now());
  if (!verified.ok) return { ok: false, status: 401, error: verified.error };
  const { claims } = verified;
  if (!claims.taskId) return { ok: false, status: 403, error: "task_ticket_required" };

  const row = await terminalWorktree(deps.db, claims.workspaceId, claims.taskId);
  if (!row) return { ok: false, status: 404, error: "no_worktree" };
  // The row outlives its directory when the worktree was removed by hand or by a failed cleanup.
  // A container Task's worktree is a host directory too — bind-mounted at its own path — so this
  // asks the same question of both, and says nothing about where the terminal will run.
  if (!existsSync(row.path)) return { ok: false, status: 409, error: "worktree_missing" };

  return {
    ok: true,
    data: {
      kind: "terminal",
      claims,
      cwd: row.path,
      cols: clampSize(params.get("cols"), MIN_COLS, MAX_COLS, 80),
      rows: clampSize(params.get("rows"), MIN_ROWS, MAX_ROWS, 24),
    },
  };
}

/** What a person's shell may see of the orchestrator's environment: who and where, never a secret. */
const PASSED_THROUGH = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "TZ"];

/**
 * The shell's environment, built from an allowlist rather than by removing what looks secret.
 * The orchestrator holds the Workspace's secret key, the stream secret and harness credentials;
 * `env` in the terminal must print none of them (Principle IV), and a denylist is one forgotten
 * variable away from doing so.
 */
export function terminalEnv(
  host: Record<string, string | undefined>,
  taskId: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED_THROUGH) {
    const value = host[key];
    if (value !== undefined) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.SOLOW_TASK_ID = taskId;
  return env;
}

/** The person's own shell, as a login shell so their profile (PATH, prompt, tools) is read. */
export function terminalCommand(host: Record<string, string | undefined>): string[] {
  return [host.SHELL || "/bin/bash", "-l"];
}

/**
 * Where the terminal was placed, as far as deciding what it runs is concerned.
 *
 * `host` is this machine, and its environment is the orchestrator's — read through the
 * allowlist above. `container` is a Task's own, and its environment is the image's
 * (`Executor.baseEnv()`): nothing of the orchestrator's is in it to leak, and an image that sets
 * `JAVA_HOME` or `NODE_PATH` for its tools needs them in the shell as much as the run does.
 * `harnessCommands` is what the container's preflight found the image can run.
 */
export type TerminalPlace =
  | { kind: "host"; env: Record<string, string | undefined> }
  | { kind: "container"; env: Record<string, string>; harnessCommands: readonly string[] };

/**
 * A shell in the container: bash when the image has it, `sh` when it does not, as a login shell.
 * The image decides, not the operator's `$SHELL`, which names a binary on this host.
 */
export const CONTAINER_SHELL = [
  "/bin/sh",
  "-c",
  "command -v bash >/dev/null 2>&1 && exec bash -l; exec sh -l",
];

/** The base every launch in this place starts from, before anything the Task adds. */
function placeEnv(place: TerminalPlace, taskId: string): Record<string, string> {
  if (place.kind === "host") return terminalEnv(place.env, taskId);
  return { ...place.env, TERM: "xterm-256color", COLORTERM: "truecolor", SOLOW_TASK_ID: taskId };
}

function shellLaunch(place: TerminalPlace, taskId: string, reason: string): TerminalLaunch {
  const cmd = place.kind === "host" ? terminalCommand(place.env) : CONTAINER_SHELL;
  return { mode: "shell", cmd, env: placeEnv(place, taskId), reason };
}

/** The harness whose own TUI can be pointed at a stored conversation. */
const MOUNTABLE_PROTOCOL = "claude_code_stream_json";

/**
 * What the terminal should run for this Task.
 *
 * The Task's newest Claude Code conversation, resumed in its own TUI — unless one of these says
 * otherwise, in which case the person's shell, with the reason shown above it:
 *
 *  - **A run holds the conversation.** The headless harness is writing to it; a second process
 *    on the same conversation would interleave two writers into one history. The chat mounts
 *    once the run stops — reopening the terminal asks again.
 *  - **There is no conversation yet**, or the harness is not one whose TUI can resume one.
 *  - **No credential** the run itself could use.
 *
 * The environment is the run's, built the run's way (`prepareHarnessEnv` over the app-owned home
 * and the Profile's Harness Config) — except its base, which is the terminal's allowlist rather
 * than the orchestrator's whole environment: the TUI is a person's interactive session, and the
 * orchestrator's own secrets have no business in it. The credential is in it, because the TUI
 * cannot talk to the model without it; it is the Workspace Owner's own.
 *
 * Not carried over from a run: the checkpoint hooks (they speak to the headless protocol) and
 * the Step's MCP and Skill libraries (materialised per round). The TUI gets the checkout's own
 * `.claude/` configuration and the Profile's settings, as `--setting-sources project,local`.
 *
 * **In a container the place answers both questions the host's filesystem answers here**: the
 * conversation is looked for in the Task's transcript store, which is what the container sees at
 * `$HOME/.claude/projects`, and the TUI must be in the image (`TerminalPlace.harnessCommands`).
 * The operator's own `~/.claude` is never consulted for a container — it is not mounted, and
 * resuming a conversation from it would mean running the TUI on this host, which is the one
 * thing a container Task's terminal must not do.
 */
export async function resolveTerminalLaunch(
  deps: { db: Db; registry: Pick<HarnessRegistry, "get">; worktreeRoot: string },
  claims: { workspaceId: string; taskId: string; cwd: string },
  place: TerminalPlace = { kind: "host", env: process.env },
): Promise<TerminalLaunch> {
  const { workspaceId, taskId } = claims;
  const where = place.kind === "host" ? "the worktree" : "the task's container";
  if (deps.registry.get(workspaceId, taskId)) {
    return shellLaunch(
      place,
      taskId,
      `The harness is working in this task's conversation right now — reopen the terminal once the run stops to join it. Meanwhile, a shell in ${where}.`,
    );
  }
  let ctx: Awaited<ReturnType<typeof loadTaskRunContext>>;
  try {
    ctx = await loadTaskRunContext(deps.db, workspaceId, taskId);
  } catch {
    return shellLaunch(place, taskId, "This task's harness could not be read — a shell instead.");
  }
  if (ctx.harnessCatalog.protocol !== MOUNTABLE_PROTOCOL) {
    return shellLaunch(
      place,
      taskId,
      `${ctx.harnessCatalog.displayName} has no conversation to mount here — a shell in ${where} instead.`,
    );
  }
  const conversation = await latestHarnessSessionId(deps.db, workspaceId, taskId);
  if (!conversation) {
    return shellLaunch(
      place,
      taskId,
      `No conversation yet — the task's first run starts one. Meanwhile, a shell in ${where}.`,
    );
  }
  if (place.kind === "container" && !place.harnessCommands.includes(ctx.harnessCatalog.command)) {
    return shellLaunch(
      place,
      taskId,
      `${ctx.harnessCatalog.displayName} is not installed in this task's image, so its conversation cannot be opened here — a shell in the task's container instead.`,
    );
  }

  const homeEnv = await conversationHomeEnv(deps.worktreeRoot, claims, conversation, place, ctx);
  if (!homeEnv) {
    return shellLaunch(
      place,
      taskId,
      place.kind === "host"
        ? "The task's conversation is not stored on this machine, so it cannot be resumed here — a shell in the worktree instead."
        : "The task's conversation is not in its transcript store, so it cannot be resumed — a shell in the task's container instead.",
    );
  }
  const { launch } = await profileHarnessConfig(
    deps.db,
    workspaceId,
    ctx.harnessProfile,
    ctx.harnessCatalog,
  );
  const shaped = prepareHarnessEnv({
    authMode: ctx.harnessProfile.authMode,
    secretCiphertext: ctx.secretCiphertext,
    baseEnv: placeEnv(place, taskId),
    subscriptionEnvVar: ctx.harnessCatalog.subscriptionEnvVar,
    meteredEnvVar: ctx.harnessCatalog.meteredEnvVar,
    profileEnv: ctx.executorProfile.config.env ?? {},
    configEnv: { ...homeEnv, ...(launch.ok ? launch.data.env : {}) },
  });
  if (!shaped.ok) {
    return shellLaunch(
      place,
      taskId,
      "This task's harness profile has no usable credential — check the Secret it points at. Meanwhile, a shell.",
    );
  }
  const settings = launch.ok ? launch.data.settings : null;
  return {
    mode: "chat",
    cmd: [
      ctx.harnessCatalog.command,
      "--resume",
      conversation,
      "--setting-sources",
      "project,local",
      ...(ctx.harnessProfile.model ? ["--model", ctx.harnessProfile.model] : []),
      ...(settings ? ["--settings", JSON.stringify(settings)] : []),
    ],
    env: { ...shaped.data, TERM: "xterm-256color", COLORTERM: "truecolor", SOLOW_TASK_ID: taskId },
  };
}

/**
 * The configuration variables that point the TUI at the home holding this conversation, or null
 * when no home it can reach holds it.
 *
 * On the host, where the conversation is kept decides whose configuration the TUI runs under. A
 * run since Decision 0027 keeps it in the Task's app-owned home; a run from before it kept it in
 * the operator's own `~/.claude`, and resuming it anywhere else finds nothing. Look, rather than
 * assume: the TUI is pointed at the directory that actually holds the file.
 *
 * In a container there is one place, the Task's transcript store, and one home — the container's
 * own, as the run had it (`needsAppOwnedHome`).
 */
async function conversationHomeEnv(
  worktreeRoot: string,
  claims: { taskId: string; cwd: string },
  conversation: string,
  place: TerminalPlace,
  ctx: Awaited<ReturnType<typeof loadTaskRunContext>>,
): Promise<Record<string, string> | null> {
  const kind = ctx.executorProfile.config.kind;
  const homePath = harnessHomePath(worktreeRoot, claims.taskId);
  if (place.kind === "container") {
    const transcripts = harnessTranscriptsPath(resolve(worktreeRoot), claims.taskId);
    if (!holdsConversation(transcripts, conversation)) return null;
    return resolveHarnessConfigEnv({ kind, home: resolve(homePath), baseEnv: place.env });
  }
  const host = place.env;
  // A run from before the home was resolved left it inside the worktree (see `legacyHomes` in
  // `harness/hermetic-home.ts`); the next round copies it out, and until then it is there.
  const taskHome = [
    resolve(homePath),
    ...(isAbsolute(homePath) ? [] : [resolve(claims.cwd, homePath)]),
  ].find((home) => holdsConversation(join(home, ".claude", "projects"), conversation));
  if (taskHome) return resolveHarnessConfigEnv({ kind, home: taskHome, baseEnv: host });
  const hostConfigDir = host.CLAUDE_CONFIG_DIR || (host.HOME ? join(host.HOME, ".claude") : null);
  if (!hostConfigDir || !holdsConversation(join(hostConfigDir, "projects"), conversation)) {
    return null;
  }
  // The run that wrote it ran under the operator's own configuration; so does its TUI.
  return {
    ...(host.HOME ? { HOME: host.HOME } : {}),
    ...(host.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: host.CLAUDE_CONFIG_DIR } : {}),
  };
}

/**
 * Whether a Claude Code conversation store holds this conversation. Conversations are filed under
 * `projects/<the working directory, flattened>/<id>.jsonl`; the directory name is the CLI's own
 * encoding of a path, so every project directory is looked in rather than one guessed.
 */
function holdsConversation(projects: string, conversation: string): boolean {
  if (!existsSync(projects)) return false;
  try {
    return readdirSync(projects).some((dir) =>
      existsSync(join(projects, dir, `${conversation}.jsonl`)),
    );
  } catch {
    return false;
  }
}

type Socket = {
  data: TerminalWsData;
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
};

/** What `startTerminal` needs to place a terminal and decide what it runs. */
export interface TerminalDeps {
  db: Db;
  registry: Pick<HarnessRegistry, "get">;
  /** `SOLOW_WORKTREE_ROOT`, unresolved — see `resolveTerminalLaunch`'s legacy-home lookup. */
  worktreeRoot: string;
  repoCacheRoot: string;
  /** `openTerminalExecutor`, with the deployment's Docker host applied; injectable for tests. */
  terminalExecutor: (
    profile: { config: ExecutorConfig },
    opts: Omit<TerminalExecutorOpts, "host">,
  ) => TerminalExecutor;
}

/** What the pane shows while a container is made, before the program's own first bytes. */
const STARTING_CONTAINER = "\x1b[2mStarting this task's container…\x1b[0m\r\n";

/**
 * Place the terminal where the Task runs, decide what it runs, and start it (roadmap B4).
 *
 * A local Task's terminal is on this host, as it always was. Any other is the Task's executor —
 * for Docker, a container of its own (`openTerminalExecutor`) — and **never this host as a
 * fallback**: a preflight that fails, a driver this build lacks and a Task whose Executor
 * Profile cannot be read all end the socket with the reason, because each of them is a case
 * where opening a shell here would hand the person, or the harness TUI they mount, the machine
 * the profile was chosen to keep them off.
 *
 * Runs after the upgrade, for two reasons. The reason a container cannot start is something to
 * put in front of the person, and a refused upgrade is unreadable from a browser socket. And a
 * container's preflight can outlast Bun's ten-second clock on an unanswered request, where a
 * socket has no such clock. The window can close while it waits; `closed` is checked after each
 * wait, and whatever was made by then is disposed of.
 */
export async function startTerminal(ws: Socket, deps: TerminalDeps): Promise<void> {
  const { workspaceId } = ws.data.claims;
  // `authorizeTerminal` refuses a ticket without one before the upgrade.
  const taskId = ws.data.claims.taskId ?? "";
  const refuse = (message: string) => {
    ws.send(JSON.stringify({ type: "error", message }));
    ws.close(1011, "terminal_refused");
  };

  let ctx: Awaited<ReturnType<typeof loadTaskRunContext>>;
  try {
    ctx = await loadTaskRunContext(deps.db, workspaceId, taskId);
  } catch {
    return refuse(
      "This task's executor could not be read, so there is no knowing where its terminal belongs — none was opened.",
    );
  }
  const kind = ctx.executorProfile.config.kind;
  if (!hasDriver(kind)) return refuse(missingDriverReason(kind));

  let placed: TerminalExecutor;
  try {
    placed = deps.terminalExecutor(ctx.executorProfile, {
      workspaceId,
      taskId,
      cwd: ws.data.cwd,
      placement: taskExecutorPlacement(deps, taskId, ctx.repositories, kind),
      harnessCommands: [ctx.harnessCatalog.command],
    });
  } catch (cause) {
    return refuse(messageOf(cause));
  }
  ws.data.dispose = placed.dispose;
  if (ws.data.closed) {
    await placed.dispose();
    return;
  }

  if (kind !== "local") ws.send(new TextEncoder().encode(STARTING_CONTAINER));
  const ready = await placed.preflight().catch((cause: unknown) => ({
    ok: false as const,
    reason: messageOf(cause),
  }));
  // Closed while the container was being made: `closeTerminal` disposed of it then, which may have
  // been before `docker run` landed — so once more, now that nothing is still making it.
  if (ws.data.closed) {
    await placed.dispose();
    return;
  }
  if (!ready.ok) return refuse(`This task's container could not be started: ${ready.reason}`);

  try {
    const place: TerminalPlace =
      kind === "local"
        ? { kind: "host", env: process.env }
        : {
            kind: "container",
            env: await placed.executor.baseEnv(),
            harnessCommands: ready.harnessCommands,
          };
    const launch = await resolveTerminalLaunch(
      deps,
      { workspaceId, taskId, cwd: ws.data.cwd },
      place,
    );
    if (ws.data.closed) {
      await placed.dispose();
      return;
    }
    ws.data.launch = launch;
    openTerminal(ws, placed.executor);
  } catch (cause) {
    // Said rather than left to reject `open`: a profile variable the TTY shim cannot carry, or a
    // shell that is not where the environment says, would otherwise leave a socket that is open,
    // silent and attached to nothing — with its container still up until the window is closed.
    refuse(`The terminal could not be started: ${messageOf(cause)}`);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function openTerminal(ws: Socket, executor: Executor): void {
  const { launch } = ws.data;
  if (!launch) throw new Error("openTerminal before startTerminal decided what to run");
  if (!executor.openTerminal) {
    ws.send(JSON.stringify({ type: "error", message: "This executor cannot open a terminal." }));
    ws.close(1011, "terminal_unsupported");
    return;
  }
  ws.send(
    JSON.stringify({
      type: "mode",
      mode: launch.mode,
      ...(launch.mode === "shell" && launch.reason ? { reason: launch.reason } : {}),
    }),
  );
  ws.data.handle = executor.openTerminal(launch.cmd, {
    cwd: ws.data.cwd,
    env: launch.env,
    cols: ws.data.cols,
    rows: ws.data.rows,
    onData: (data) => ws.send(data),
    onExit: (code) => {
      ws.send(JSON.stringify({ type: "exit", code }));
      ws.close(1000, "exited");
    },
  });
}

export function terminalMessage(ws: Socket, raw: string | Buffer): void {
  const handle = ws.data.handle;
  if (typeof raw !== "string") {
    // Keystrokes before the program exists have nothing to reach; the prompt is not up yet.
    handle?.write(new Uint8Array(raw));
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "resize"
  ) {
    const { cols, rows } = message as { cols?: unknown; rows?: unknown };
    // Kept as well as applied: a window resized while its container is still starting opens at
    // the size it has by then, not the one it asked for at the upgrade.
    ws.data.cols = clampSize(String(cols), MIN_COLS, MAX_COLS, ws.data.cols);
    ws.data.rows = clampSize(String(rows), MIN_ROWS, MAX_ROWS, ws.data.rows);
    handle?.resize(ws.data.cols, ws.data.rows);
  }
}

/**
 * The window closed: hang up, as a terminal emulator does, and give back where it ran — a
 * container is removed, and with it anything the hang-up left running inside.
 */
export function closeTerminal(ws: Socket): void {
  ws.data.closed = true;
  ws.data.handle?.kill();
  ws.data.handle = undefined;
  void ws.data.dispose?.();
}
