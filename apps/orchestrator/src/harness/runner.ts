/// <reference types="bun-types" />
import type { AcpMcpServer } from "@solow/acp";
import type { FailureSignal } from "@solow/core";

/**
 * Harness runner (spec F04 / task TASK-014, issue #58). SoloW drives an external coding
 * harness over whichever protocol its catalog row declares. This interface is the seam that keeps
 * orchestration independent of both: `AcpRunner` speaks the Agent Client Protocol (Decision
 * 0003), `ClaudeCodeRunner` speaks Claude Code's own stream-JSON mode, `createHarnessRunner`
 * picks between them, and `FakeHarnessRunner` is the deterministic one the lifecycle tests drive.
 *
 * Credential-isolation note (finding C1): `env` carries only the single credential shaped by
 * the billing guard; the orchestrator's secret store is never exposed to the harness process.
 */
export type HarnessStreamEvent =
  /**
   * A line of the harness's output, and *whose* line it is (issue #2).
   *
   * The channel used to be collapsed into the text — thinking was marked with a "· " prefix and
   * everything else was indistinguishable — which meant the session log could not tell a user
   * turn from an assistant turn from a mode line. Both protocol layers already carry it, so this
   * is the seam that was throwing it away. Presentation moved to the wire projection, so the
   * durable record stays clean for readers that are not a terminal (#16, #84).
   */
  | { kind: "stdout"; channel: HarnessTextChannel; text: string }
  /**
   * A tool invocation. `callId` is what lets the transcript fold a call together with its
   * result; `input` is the raw arguments as the protocol reported them, narrowed to the
   * allowlist further down in `task-run.ts` rather than here — this seam is protocol-shaped,
   * the allowlist is policy, and the policy must apply to every adapter that reaches it.
   */
  | { kind: "tool_use"; name: string; callId: string | null; input: unknown; status: string | null }
  /** How a tool call finished. Truncation of `output` belongs to the same policy layer. */
  | { kind: "tool_result"; callId: string | null; ok: boolean; output: string | null }
  /** One completed turn's token usage (issue #14). Counts and model only — never content. */
  | {
      kind: "usage";
      /** The assistant turn this belongs to — the deduplication key. See events.ts. */
      messageId: string | null;
      /** False when the turn completed but the harness stated no usage for it. */
      reported: boolean;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  /**
   * The harness is asking to do something its own policy will not wave through (issue #58, AC-4).
   *
   * Published and logged *before* it is answered, whichever way it is answered: a permission
   * that was granted without the operator ever seeing it is exactly what this event exists to
   * make impossible. Carries the title, the kind and the options the harness offered — never the
   * tool call's raw input, which can hold the contents of a file being written (Principle IV).
   */
  | {
      kind: "permission_request";
      requestId: string;
      title: string;
      toolKind: string | null;
      options: Array<{ optionId: string; name: string; kind: string }>;
    }
  /**
   * What the harness advertised it can be (issue #94 AC-2): its model list and its mode list, as
   * ids. Emitted at most once per run, at the handshake, and only when the harness said anything —
   * so a consumer refreshing a cache never mistakes silence for "the harness offers nothing".
   */
  | { kind: "capabilities"; models: string[]; modes: string[] }
  /** How a permission was settled, and by whom — the audit half of AC-4. */
  | {
      kind: "permission_resolved";
      requestId: string;
      optionId: string | null;
      decidedBy: "operator" | "policy";
    };

/** Who produced a line: the model, its reasoning, the operator, or the machinery. */
export type HarnessTextChannel = "assistant" | "thinking" | "user" | "system";

export type HarnessOutcome = { kind: "completed" } | { kind: "failed"; signal: FailureSignal };

/**
 * What became of an operator's answer to a permission (issue #58, AC-4).
 *
 * Three outcomes rather than a boolean, because the terminal has to say something true about
 * each: the answer landed, the question was already over, or the option clicked was not one the
 * harness offered. A run mid-turn that answers "already settled" must not be reported to the
 * operator as a harness that is no longer running.
 */
export type PermissionAnswer = "answered" | "not_pending" | "option_not_offered";

export interface HarnessStartOpts {
  command: string;
  args: string[];
  /**
   * The *repository* to run in, not a per-Task worktree.
   *
   * The harness creates its own worktree (`claude --worktree`), which is what lets several Tasks
   * share one repository safely. Pointing this at a worktree SoloW had already made would
   * nest one inside another and put the harness's edits somewhere nothing downstream reads.
   */
  cwd: string;
  env: Record<string, string>;
  /**
   * Name for the worktree the harness should create, or null to run in `cwd` as-is.
   *
   * A Task's first round passes a name and the harness creates the worktree. Later rounds — a
   * reviewer asking for changes — pass null and point `cwd` at the worktree that already
   * exists: asking for it again would either fail or branch a fresh one from the base ref,
   * throwing away everything the earlier round produced.
   */
  worktreeName: string | null;
  /** What the harness is asked to do this round — the Task brief, plus any review feedback. */
  prompt: string;
  /**
   * MCP servers for a runtime that takes them over its protocol (ACP's `session/new`); a
   * runtime that takes them as arguments finds them in `args` instead (spec F24).
   */
  mcpServers?: AcpMcpServer[];
  onEvent: (e: HarnessStreamEvent) => void;
}

export interface HarnessHandle {
  outcome: Promise<HarnessOutcome>;
  /**
   * The directory the harness is actually working in, once it says so.
   *
   * SoloW adopts this rather than assuming a path: the worktree is the harness's to create,
   * and every later step — diff, commit on approve, discard on reject, cleanup — has to act on
   * the real one. `null` means the harness never reported a workspace, which the lifecycle must
   * treat as a failure to isolate rather than carry on regardless.
   */
  workspacePath: Promise<string | null>;
  /**
   * Operator input from the review terminal (TASK-022), delivered as another turn. Resolves
   * `false` when the run has already finished and the input could not be accepted.
   */
  send(text: string): Promise<boolean>;
  /**
   * Answer a permission the harness asked for (issue #58, AC-4), reporting what became of it.
   *
   * Optional because not every protocol has a permission channel to answer on: Claude Code's
   * stream-JSON mode decides permissions inside the CLI, and saying so by omitting the method
   * is more honest than a shared no-op that pretends every harness could be asked.
   */
  respondPermission?(requestId: string, optionId: string): Promise<PermissionAnswer>;
  stop(): Promise<void>;
}

export interface HarnessRunner {
  start(opts: HarnessStartOpts): HarnessHandle;
}

/** Deterministic runner for tests: emits scripted events then completes. */
export class FakeHarnessRunner implements HarnessRunner {
  /** Prompts the lifecycle sent, in order — assert on these to check what the harness was told. */
  readonly prompts: string[] = [];
  /** Operator input that reached the harness. */
  readonly inputs: string[] = [];
  /** Worktree names the lifecycle asked for — `null` on a resume round, which asks for none. */
  readonly worktreeNames: (string | null)[] = [];
  /** Permission answers that reached the harness, so the AC-4 round trip is assertable. */
  readonly permissionAnswers: Array<{ requestId: string; optionId: string }> = [];
  stopped = false;

  constructor(
    private readonly script: HarnessStreamEvent[] = [
      { kind: "stdout", channel: "assistant", text: "ok" },
    ],
    /** The workspace the fake claims to be working in; defaults to the repository it was given. */
    private readonly workspace?: (opts: HarnessStartOpts) => string | null,
  ) {}

  start(opts: HarnessStartOpts): HarnessHandle {
    this.prompts.push(opts.prompt);
    this.worktreeNames.push(opts.worktreeName);
    for (const e of this.script) opts.onEvent(e);
    return {
      outcome: Promise.resolve<HarnessOutcome>({ kind: "completed" }),
      workspacePath: Promise.resolve<string | null>(
        this.workspace ? this.workspace(opts) : (opts.worktreeName ?? opts.cwd),
      ),
      send: async (text: string) => {
        this.inputs.push(text);
        opts.onEvent({ kind: "stdout", channel: "user", text });
        return true;
      },
      respondPermission: async (requestId: string, optionId: string) => {
        this.permissionAnswers.push({ requestId, optionId });
        opts.onEvent({ kind: "permission_resolved", requestId, optionId, decidedBy: "operator" });
        return "answered" as const;
      },
      stop: async () => {
        this.stopped = true;
      },
    };
  }
}
