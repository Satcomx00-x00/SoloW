import { type ClaudeUpdate, encodeUserTurn, parseStreamLine, toUpdates } from "./events.js";

/**
 * A headless Claude Code session (task TASK-014).
 *
 * `claude -p --input-format stream-json --output-format stream-json` is the CLI's programmatic
 * mode: newline-delimited JSON both ways, so a turn can be sent mid-session and every message,
 * tool call and result arrives as a parseable event rather than as terminal text to scrape.
 *
 * **`--worktree` is not optional.** Several Tasks run against one repository at the same time,
 * and two agents editing one working tree would corrupt each other's changes (Principle II).
 * The flag is added by `buildArgs`, not by the caller, so no call site can leave it off.
 *
 * This module never spawns the process itself — the caller supplies `spawn` (issue #1's
 * `Executor.spawn` in the orchestrator). That keeps this package agent-protocol-only and leaves
 * exactly one place in the orchestrator allowed to touch the execution host.
 */

/** A long-lived child process, shaped for an interactive stream-JSON protocol. */
export interface ChildProcessHandle {
  stdin: {
    write(data: string): number | Promise<number>;
    flush(): Promise<number>;
    end(): Promise<void>;
  };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

/** Launches the CLI process. Implemented by the orchestrator's `Executor.spawn`. */
export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ChildProcessHandle;

/** How the session ended, from the CLI's own `result` event. */
export interface ClaudeOutcome {
  ok: boolean;
  /** The CLI's `result.subtype` — `success`, `error_max_turns`, and so on. */
  subtype: string | null;
  text: string | null;
}

export interface ClaudeSessionOptions {
  /** The `claude` binary. */
  command: string;
  /** Extra arguments from configuration, appended after the ones GateControl requires. */
  extraArgs?: string[];
  /**
   * The repository to run in. Claude Code creates its worktree relative to this, so it is the
   * repository root — *not* a worktree GateControl made, which would nest one inside another.
   */
  cwd: string;
  /** Environment for the agent process. Replaces, never extends (Principle IV). */
  env: Record<string, string>;
  /** Launches the CLI process — the orchestrator's `Executor.spawn`. */
  spawn: SpawnFn;
  /**
   * Worktree to create, or null to work in `cwd` directly because it already is one. Asking
   * for a worktree from inside a worktree would nest one in the other.
   */
  worktreeName: string | null;
  /** Claude Code's permission mode for the run. */
  permissionMode: string;
  onUpdate: (update: ClaudeUpdate) => void;
  onStderr?: (text: string) => void;
}

/**
 * The arguments GateControl requires, in front of any configured extras.
 *
 * Exported so a test can assert the shape without spawning anything — in particular that
 * `--worktree` is always present, which is the guarantee the rest of the system leans on.
 */
export function buildArgs(options: {
  worktreeName: string | null;
  permissionMode: string;
  extraArgs?: string[];
}): string[] {
  return [
    // Non-interactive, streaming both directions.
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // Without this the CLI refuses to emit stream-json on stdout.
    "--verbose",
    // The isolation guarantee: one worktree per Task, named after it. Omitted only when the
    // caller is already inside that worktree and is continuing the same Task.
    ...(options.worktreeName ? ["--worktree", options.worktreeName] : []),
    // A headless run has nobody to answer a permission prompt; the worktree and the review gate
    // are the safety boundary instead (see the orchestrator's runner for the reasoning).
    "--permission-mode",
    options.permissionMode,
    ...(options.extraArgs ?? []),
  ];
}

export interface ClaudeSession {
  outcome: Promise<ClaudeOutcome>;
  /**
   * The directory the agent is actually working in — the worktree Claude Code created, read
   * from the session's own init event. Resolves null if the CLI never reported one, which the
   * caller must treat as a failure to establish an isolated workspace rather than ignore.
   */
  workspacePath: Promise<string | null>;
  /** Queue another user turn. False once the session has finished. */
  send(text: string): boolean;
  stop(): Promise<void>;
}

/** How much stderr to keep for failure classification. Enough for a message, not a log file. */
const STDERR_TAIL_LIMIT = 8_192;

export function startClaudeSession(
  options: ClaudeSessionOptions,
  prompt: string,
): ClaudeSession & { stderrTail: () => string } {
  const proc = options.spawn(
    [
      options.command,
      ...buildArgs({
        worktreeName: options.worktreeName,
        permissionMode: options.permissionMode,
        ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
      }),
    ],
    // Replaces the environment rather than extending it: the child sees exactly the one
    // credential the billing guard shaped, and nothing else of the orchestrator's (Principle IV).
    { cwd: options.cwd, env: options.env },
  );

  let stderrTail = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      const text = decoder.decode(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      options.onStderr?.(text);
    }
  })();

  let resolveWorkspace: (path: string | null) => void = () => {};
  const workspacePath = new Promise<string | null>((resolve) => {
    resolveWorkspace = resolve;
  });
  let workspaceSettled = false;

  let finished = false;
  let stopped = false;

  const write = (line: string) => {
    proc.stdin.write(line);
    return proc.stdin.flush();
  };

  // The opening turn. Sent as stream-json like every later one, so there is a single path for
  // "give the agent something to do".
  void write(encodeUserTurn(prompt));

  const outcome: Promise<ClaudeOutcome> = (async () => {
    let last: ClaudeOutcome | null = null;
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      // Split on newlines and keep the trailing partial line for the next chunk: a JSON object
      // can straddle a read boundary, and parsing half of one loses the event.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) continue;
        for (const update of toUpdates(event)) {
          if (update.kind === "session" && !workspaceSettled) {
            workspaceSettled = true;
            resolveWorkspace(update.cwd);
          }
          if (update.kind === "result") {
            last = { ok: update.ok, subtype: update.subtype, text: update.text };
          }
          options.onUpdate(update);
        }
      }
    }

    finished = true;
    if (!workspaceSettled) {
      workspaceSettled = true;
      resolveWorkspace(null);
    }
    await proc.exited;

    if (stopped) return { ok: true, subtype: "stopped", text: null };
    // No result event means the CLI died before finishing its turn — an exit code alone does
    // not tell us it succeeded, so absence is treated as failure.
    return last ?? { ok: false, subtype: "no_result", text: null };
  })();

  return {
    outcome,
    workspacePath,
    stderrTail: () => stderrTail,
    send(text: string) {
      if (finished || stopped) return false;
      void write(encodeUserTurn(text));
      return true;
    },
    async stop() {
      stopped = true;
      // Closing stdin lets the CLI finish the turn it is on and exit; the kill is the backstop
      // for one that ignores EOF.
      try {
        await proc.stdin.end();
      } catch {
        // Already closed.
      }
      proc.kill();
      await proc.exited;
    },
  };
}
