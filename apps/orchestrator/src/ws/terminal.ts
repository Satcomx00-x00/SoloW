import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type StreamTicketClaims, verifyStreamTicket } from "@solow/core/stream";
import type { Db } from "@solow/db";
import { prepareHarnessEnv } from "../billing/guard.js";
import { latestHarnessSessionId, loadTaskRunContext, terminalWorktree } from "../data.js";
import type { Executor, TerminalHandle } from "../executor/types.js";
import { profileHarnessConfig } from "../harness/harness-config.js";
import { resolveHarnessConfigEnv } from "../harness/hermetic-home.js";
import type { HarnessRegistry } from "../harness/registry.js";
import { harnessHomePath } from "../worktree/manager.js";

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
  launch: TerminalLaunch;
  handle?: TerminalHandle | undefined;
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
  // A container executor records the path inside the container; there is nothing on this host
  // to open a shell in.
  if (!existsSync(row.path)) return { ok: false, status: 409, error: "worktree_not_on_host" };

  return {
    ok: true,
    data: {
      kind: "terminal",
      claims,
      cwd: row.path,
      // Decided by `resolveTerminalLaunch` before the upgrade; a shell until then.
      launch: shellLaunch(process.env, claims.taskId, ""),
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

function shellLaunch(
  host: Record<string, string | undefined>,
  taskId: string,
  reason: string,
): TerminalLaunch {
  return { mode: "shell", cmd: terminalCommand(host), env: terminalEnv(host, taskId), reason };
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
 */
export async function resolveTerminalLaunch(
  deps: { db: Db; registry: Pick<HarnessRegistry, "get">; worktreeRoot: string },
  claims: { workspaceId: string; taskId: string; cwd: string },
  host: Record<string, string | undefined> = process.env,
): Promise<TerminalLaunch> {
  const { workspaceId, taskId } = claims;
  if (deps.registry.get(workspaceId, taskId)) {
    return shellLaunch(
      host,
      taskId,
      "The harness is working in this task's conversation right now — reopen the terminal once the run stops to join it. Meanwhile, a shell in the worktree.",
    );
  }
  let ctx: Awaited<ReturnType<typeof loadTaskRunContext>>;
  try {
    ctx = await loadTaskRunContext(deps.db, workspaceId, taskId);
  } catch {
    return shellLaunch(host, taskId, "This task's harness could not be read — a shell instead.");
  }
  if (ctx.harnessCatalog.protocol !== MOUNTABLE_PROTOCOL) {
    return shellLaunch(
      host,
      taskId,
      `${ctx.harnessCatalog.displayName} has no conversation to mount here — a shell in the worktree instead.`,
    );
  }
  const conversation = await latestHarnessSessionId(deps.db, workspaceId, taskId);
  if (!conversation) {
    return shellLaunch(
      host,
      taskId,
      "No conversation yet — the task's first run starts one. Meanwhile, a shell in the worktree.",
    );
  }

  /*
   * Where the conversation is kept decides whose configuration the TUI runs under. A run since
   * Decision 0027 keeps it in the Task's app-owned home; a run from before it kept it in the
   * operator's own `~/.claude`, and resuming it anywhere else finds nothing. Look, rather than
   * assume: the TUI is pointed at the directory that actually holds the file.
   */
  const homePath = harnessHomePath(deps.worktreeRoot, taskId);
  // A run from before the home was resolved left it inside the worktree (see `legacyHomes` in
  // `harness/hermetic-home.ts`); the next round copies it out, and until then it is there.
  const taskHome = [
    resolve(homePath),
    ...(isAbsolute(homePath) ? [] : [resolve(claims.cwd, homePath)]),
  ].find((home) => holdsConversation(join(home, ".claude"), conversation));
  const hostConfigDir = host.CLAUDE_CONFIG_DIR || (host.HOME ? join(host.HOME, ".claude") : null);
  const keptIn = taskHome
    ? "task"
    : hostConfigDir && holdsConversation(hostConfigDir, conversation)
      ? "operator"
      : null;
  if (!keptIn) {
    return shellLaunch(
      host,
      taskId,
      "The task's conversation is not stored on this machine, so it cannot be resumed here — a shell in the worktree instead.",
    );
  }
  const homeEnv =
    keptIn === "task"
      ? await resolveHarnessConfigEnv({
          kind: ctx.executorProfile.config.kind,
          home: taskHome ?? resolve(homePath),
          baseEnv: host,
        })
      : // The run that wrote it ran under the operator's own configuration; so does its TUI.
        {
          ...(host.HOME ? { HOME: host.HOME } : {}),
          ...(host.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: host.CLAUDE_CONFIG_DIR } : {}),
        };
  const { launch } = await profileHarnessConfig(
    deps.db,
    workspaceId,
    ctx.harnessProfile,
    ctx.harnessCatalog,
  );
  const shaped = prepareHarnessEnv({
    authMode: ctx.harnessProfile.authMode,
    secretCiphertext: ctx.secretCiphertext,
    baseEnv: terminalEnv(host, taskId),
    subscriptionEnvVar: ctx.harnessCatalog.subscriptionEnvVar,
    meteredEnvVar: ctx.harnessCatalog.meteredEnvVar,
    profileEnv: ctx.executorProfile.config.env ?? {},
    configEnv: { ...homeEnv, ...(launch.ok ? launch.data.env : {}) },
  });
  if (!shaped.ok) {
    return shellLaunch(
      host,
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
 * Whether Claude Code's store under `configDir` holds this conversation. Conversations are
 * filed under `projects/<the working directory, flattened>/<id>.jsonl`; the directory name is the
 * CLI's own encoding of a path, so every project directory is looked in rather than one guessed.
 */
function holdsConversation(configDir: string, conversation: string): boolean {
  const projects = join(configDir, "projects");
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

export function openTerminal(ws: Socket, executor: Executor): void {
  if (!executor.openTerminal) {
    ws.send(JSON.stringify({ type: "error", message: "This executor cannot open a terminal." }));
    ws.close(1011, "terminal_unsupported");
    return;
  }
  const { launch } = ws.data;
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
  if (!handle) return;
  if (typeof raw !== "string") {
    handle.write(new Uint8Array(raw));
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
    handle.resize(
      clampSize(String(cols), MIN_COLS, MAX_COLS, ws.data.cols),
      clampSize(String(rows), MIN_ROWS, MAX_ROWS, ws.data.rows),
    );
  }
}

/** The window closed: hang up, as a terminal emulator does. */
export function closeTerminal(ws: Socket): void {
  ws.data.handle?.kill();
  ws.data.handle = undefined;
}
