import { type ChildProcessHandle, startClaudeSession } from "@solow/claude-code";
import { harnessProtocolDescriptor } from "@solow/contracts";
import type { Executor } from "../executor/types.js";

/**
 * One answer from a Task's own harness, outside any run (the Brief tab's Explain).
 *
 * The same binary, the same credential and the same model as the Task's runs — because that is
 * what the operator is paying for and what they asked for — driven for exactly one print turn:
 * no worktree, the permission mode that edits nothing, the instruction as an appended system
 * prompt and the material as the prompt. The text of the turn is the answer; nothing is
 * recorded anywhere, and the process is gone with its temporary directory.
 *
 * **One turn means closing stdin.** In stream-json input mode the CLI finishes a turn and then
 * waits for the next one until its input ends — that is what lets a run be steered. Here the
 * first `result` event *is* the answer, so the session is stopped on it (stdin closed, the kill
 * as backstop); the session's own outcome resolves only on exit and would otherwise wait out
 * the timeout on a harness that had long since answered.
 *
 * Only the protocol this build can drive is asked (`claude_code_stream_json`); a harness on
 * another protocol answers with a reason instead of a hang.
 */
export interface HarnessExplainInput {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  protocol: string;
  /** The model the Harness Profile pinned, or absent to let the CLI choose. */
  model?: string;
  system: string;
  prompt: string;
}

export interface HarnessExplainResult {
  ok: boolean;
  text: string | null;
  model: string | null;
  reason: string | null;
  failure: "credential" | "harness" | null;
}

export const EXPLAIN_TIMEOUT_MS = 120_000;

function failed(reason: string): HarnessExplainResult {
  return { ok: false, text: null, model: null, reason, failure: "harness" };
}

function reasonFor(cause: unknown, command: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ENOENT|not found|No such file/i.test(message)) {
    return `"${command}" could not be started — is it installed and on PATH for the orchestrator?`;
  }
  return message;
}

export async function explainWithHarness(
  executor: Executor,
  input: HarnessExplainInput,
): Promise<HarnessExplainResult> {
  const descriptor = harnessProtocolDescriptor(input.protocol);
  if (!descriptor.driven || input.protocol !== "claude_code_stream_json") {
    return failed(
      `this build cannot ask a harness on protocol "${input.protocol}" for an explanation`,
    );
  }

  let model: string | null = null;
  let streamed = "";
  let result: { ok: boolean; subtype: string | null; text: string | null } | null = null;
  let session: ReturnType<typeof startClaudeSession> | undefined;
  try {
    session = startClaudeSession(
      {
        command: input.command,
        extraArgs: [...input.args, "--append-system-prompt", input.system],
        cwd: input.cwd,
        env: input.env,
        spawn: (cmd, opts) => executor.spawn(cmd, opts) as unknown as ChildProcessHandle,
        worktreeName: null,
        permissionMode: "plan",
        ...(input.model ? { model: input.model } : {}),
        onUpdate: (update) => {
          if (update.kind === "usage" && update.model) model = update.model;
          if (update.kind === "text" && update.channel === "assistant") streamed += update.text;
          if (update.kind === "result" && result === null) {
            result = { ok: update.ok, subtype: update.subtype, text: update.text };
            // The answer is in; end the input so the CLI exits instead of waiting for a turn
            // that is never coming. After the current tick: the session handle is assigned
            // once `startClaudeSession` returns, and updates arrive from stdout after that.
            queueMicrotask(() => void session?.stop());
          }
        },
      },
      input.prompt,
    );
  } catch (cause) {
    return failed(reasonFor(cause, input.command));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      session.outcome,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void session?.stop();
          reject(
            new Error(
              `the harness did not answer within ${Math.round(EXPLAIN_TIMEOUT_MS / 1000)}s`,
            ),
          );
        }, EXPLAIN_TIMEOUT_MS);
      }),
    ]);
    // The turn's result, captured before the session was stopped (the outcome of a stopped
    // session says "stopped" and carries no text). What the assistant actually said, block by
    // block, is the answer; the result event's own text is the fallback for a harness that
    // streamed nothing and only summarised at the end.
    const turn: { ok: boolean; subtype: string | null; text: string | null } = result ?? outcome;
    const text = (streamed.trim() || turn.text || "").trim();
    if (!turn.ok) return failed(turn.subtype ?? "the harness did not finish its answer");
    if (!text) return failed("the harness gave no answer");
    return { ok: true, text, model, reason: null, failure: null };
  } catch (cause) {
    return failed(reasonFor(cause, input.command));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
