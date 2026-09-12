import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WorkflowCheckpoint } from "@solow/contracts";
import { checkpointFor, describeCheckpoints, type ToolCallFacts } from "@solow/core";
import { z } from "zod";
import { PERMISSION_DEADLINE_MS, PermissionInbox } from "./permissions.js";
import type { HarnessStreamEvent, PermissionAnswer } from "./runner.js";

/**
 * Workflow checkpoints on Claude Code (review analysis of task 9f4bd3e9, point 4): a Step's
 * rules, enforced through the CLI's own `PreToolUse` hook, answered by a person.
 *
 * The CLI in stream-json mode decides permissions inside itself and offers no channel to ask an
 * operator on — `claude-code-runner.ts` says so, and `acp-runner.ts` is where SoloW *can* ask.
 * Hooks are the channel stream-json does have: a command the CLI runs before each tool call,
 * handed the call as JSON on stdin, whose JSON on stdout can allow or deny it, and which runs
 * under `bypassPermissions` too. So the checkpoint is a hook, and the question is only how the
 * hook reaches the orchestrator.
 *
 * **Over the filesystem, not the network.** The hook runs where the harness runs — on the
 * host, or inside a container whose network the profile chose — and the one thing every
 * executor already shares with the orchestrator is a directory: the same mechanism that keeps a
 * containerised run's transcripts (`harnessTranscriptsPath`). The hook is a dozen lines of POSIX
 * `sh`: copy stdin to `<store>/<id>.request`, wait for `<store>/<id>.answer`, print it. This
 * side watches the store, applies the Step's rules to the request, and either answers at once
 * (no rule fired: an empty object, which the CLI reads as "no opinion") or raises a
 * `permission_request` on the run's stream, waits for the operator through the same
 * `PermissionInbox` ACP uses, and writes the CLI's allow-or-deny. Nobody answering is a
 * refusal, for the reason the inbox gives.
 *
 * What this is and is not. It is a control on an honest harness's autonomy — the operator is
 * asked before the migration runs, not shown afterwards that it did. It is not a security
 * boundary: the hook runs as the harness's own user, so a harness set on answering itself could.
 * The review gate on the diff remains the boundary (Principle I); this decides what reaches it.
 */

/** The hook's copy of the CLI's tool call. Only the fields the rules read; never persisted. */
const hookInput = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.unknown()).default({}),
  cwd: z.string().optional(),
});

/** The facts a rule reads, out of the tool schemas Claude Code has for a shell and for a file. */
export function toolCallFacts(toolName: string, input: Record<string, unknown>): ToolCallFacts {
  const text = (key: string): string | null => {
    const value = input[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  switch (toolName) {
    case "Bash":
      return { command: text("command") };
    case "Edit":
    case "Write":
    case "MultiEdit":
      return { path: text("file_path") };
    case "NotebookEdit":
      return { path: text("notebook_path") };
    default:
      return {};
  }
}

/** The tools the hook is installed on — derived from the rules, so a command-only Step never pays for a hook on every edit. */
export function hookMatcher(rules: readonly WorkflowCheckpoint[]): string {
  const tools: string[] = [];
  if (rules.some((rule) => rule.on === "command")) tools.push("Bash");
  if (rules.some((rule) => rule.on === "write"))
    tools.push("Edit", "Write", "MultiEdit", "NotebookEdit");
  return tools.join("|");
}

/**
 * The relay's half of the hook, written into the store at install. POSIX `sh` and nothing that
 * is not in busybox: it runs inside whatever image the executor profile named.
 *
 * Atomic on both sides — written under a temporary name and renamed — so neither party ever
 * reads half a file. The wait is bounded, and by *more* than the inbox's deadline: when the
 * orchestrator is gone the hook eventually gives up with no output, which the CLI reads as "no
 * opinion", the same as no hook at all. A hook that blocked forever would hang the run on an
 * orchestrator restart, which is the failure `reconcile.ts` exists to prevent.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# SoloW checkpoint relay — written by the orchestrator for one run; see harness/checkpoints.ts.
set -u
dir="$(dirname "$0")"
name="$(date +%s)-$$"
cat > "$dir/$name.tmp" && mv "$dir/$name.tmp" "$dir/$name.request"
i=0
while [ ! -f "$dir/$name.answer" ]; do
  i=$((i + 1))
  if [ "$i" -gt __LIMIT__ ]; then rm -f "$dir/$name.request"; exit 0; fi
  sleep 0.2 2>/dev/null || sleep 1
done
cat "$dir/$name.answer"
rm -f "$dir/$name.request" "$dir/$name.answer"
exit 0
`;

/** How the hook polls, and for how long, before giving up on an orchestrator that is gone. */
const POLL_MS = 200;
const HOOK_GRACE_MS = 60_000;

export interface CheckpointRelayOptions {
  /** The per-Task directory shared with the executor — `checkpointStorePath`. */
  store: string;
  rules: readonly WorkflowCheckpoint[];
  onEvent: (event: HarnessStreamEvent) => void;
  /** How long a person gets; the inbox's own default otherwise. */
  deadlineMs?: number;
  /** Something unique to this run, so request ids never collide with an earlier round's. */
  runTag: string;
}

/**
 * One run's checkpoint relay: installs the hook, watches the store, answers.
 *
 * Constructed synchronously — the runner's `start` is — with `node:fs`'s sync calls, which is
 * fine for two small files. Everything after install is event-driven, with a slow poll behind
 * `fs.watch` because a bind-mounted directory written from inside a container does not always
 * raise an inotify event on the host.
 */
export class CheckpointRelay {
  private readonly inbox: PermissionInbox;
  private readonly seen = new Set<string>();
  private watcher: ReturnType<typeof watch> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** The CLI's `--settings` for this run: the hook, on the tools the rules watch. */
  readonly settings: string;
  readonly hookPath: string;

  constructor(private readonly options: CheckpointRelayOptions) {
    const deadlineMs = options.deadlineMs ?? PERMISSION_DEADLINE_MS;
    // Refuse when nobody answers — the posture is not a choice here. An operator who wanted the
    // harness to proceed unasked would not have declared the checkpoint.
    this.inbox = new PermissionInbox(deadlineMs, "refuse");
    this.hookPath = join(options.store, "hook.sh");
    mkdirSync(options.store, { recursive: true });
    for (const stale of readdirSync(options.store)) {
      // Leftovers of a round that died mid-question: nothing is waiting on them any more.
      if (/\.(request|answer|tmp)$/.test(stale)) unlinkSync(join(options.store, stale));
    }
    const limit = Math.ceil((deadlineMs + HOOK_GRACE_MS) / POLL_MS);
    writeFileSync(this.hookPath, HOOK_SCRIPT.replace("__LIMIT__", String(limit)));
    chmodSync(this.hookPath, 0o755);
    this.settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: hookMatcher(options.rules),
            hooks: [
              {
                type: "command",
                command: `sh ${this.hookPath}`,
                // In seconds. Past this the CLI proceeds as if there were no hook, so it has to
                // outlast the operator's deadline and the hook's own grace.
                timeout: Math.ceil((deadlineMs + HOOK_GRACE_MS) / 1000) + 30,
              },
            ],
          },
        ],
      },
    });
  }

  /** Start answering. Idempotent. */
  start(): void {
    if (this.watcher || this.closed) return;
    this.options.onEvent({
      kind: "stdout",
      channel: "system",
      text: `\n[checkpoints armed — ${describeCheckpoints(this.options.rules)}]\n`,
    });
    try {
      this.watcher = watch(this.options.store, () => this.sweep());
    } catch {
      // No watcher — the poll below is the whole mechanism then, which is slower, not broken.
      this.watcher = null;
    }
    this.poll = setInterval(() => this.sweep(), POLL_MS * 5);
    this.sweep();
  }

  /** The operator's answer to a request this relay raised. */
  answer(requestId: string, optionId: string): PermissionAnswer {
    return this.inbox.answer(requestId, optionId);
  }

  /** Stop watching and refuse whatever is still open, so no hook is left waiting on nobody. */
  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.inbox.close();
  }

  private sweep(): void {
    if (this.closed) return;
    let names: string[];
    try {
      names = readdirSync(this.options.store);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".request") || this.seen.has(name)) continue;
      this.seen.add(name);
      void this.handle(name.slice(0, -".request".length));
    }
  }

  private async handle(stem: string): Promise<void> {
    const requestPath = join(this.options.store, `${stem}.request`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(requestPath, "utf8"));
    } catch {
      // Unreadable, or gone already: the hook gave up, or wrote something that is not a tool
      // call. Nothing to decide, and nothing to answer.
      this.reply(stem, {});
      return;
    }
    const parsed = hookInput.safeParse(raw);
    if (!parsed.success) {
      this.reply(stem, {});
      return;
    }
    const { tool_name: toolName, tool_input: input, cwd } = parsed.data;
    const facts = toolCallFacts(toolName, input);
    const rule = checkpointFor(this.options.rules, facts, cwd ?? null);
    if (!rule) {
      this.reply(stem, {});
      return;
    }
    // Unique across rounds: the SPA pairs a request with its resolution over the Task's whole
    // replayed history, and the hook's own stem restarts with the process clock.
    const requestId = `checkpoint:${this.options.runTag}:${stem}`;
    const subject = facts.command ?? facts.path ?? toolName;
    const options = [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    // Surfaced first, answered second — always in that order (AC-4 of issue #58, the same rule
    // the ACP runner keeps). The title carries the label and the command or path, never the
    // tool call's whole input.
    this.options.onEvent({
      kind: "permission_request",
      requestId,
      title: `${rule.label}: ${subject.length > 200 ? `${subject.slice(0, 200)}…` : subject}`,
      toolKind: toolName,
      options,
    });
    const resolution = await this.inbox.ask({
      requestId,
      sessionId: null,
      toolCallId: null,
      title: rule.label,
      kind: toolName,
      options,
    });
    this.options.onEvent({
      kind: "permission_resolved",
      requestId,
      optionId: resolution.optionId,
      decidedBy: resolution.decidedBy,
    });
    const allowed = resolution.outcome === "selected" && resolution.optionId === "allow";
    if (!allowed && resolution.decidedBy === "policy") {
      this.options.onEvent({
        kind: "stdout",
        channel: "system",
        text: `\n[checkpoint refused by policy — nobody answered "${rule.label}" in time]\n`,
      });
    }
    this.reply(stem, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allowed ? "allow" : "deny",
        permissionDecisionReason: allowed
          ? `Allowed by the reviewer at the "${rule.label}" checkpoint.`
          : resolution.decidedBy === "operator"
            ? `The reviewer refused this at the "${rule.label}" checkpoint. Do not do it another way; leave it undone and report it as an open item.`
            : `Nobody answered the "${rule.label}" checkpoint in time, so it is refused. Do not do it another way; leave it undone and report it as an open item.`,
      },
    });
  }

  /** The hook's stdout, written atomically so the hook never prints half an answer. */
  private reply(stem: string, output: Record<string, unknown>): void {
    const tmp = join(this.options.store, `${stem}.answer.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(output));
      renameSync(tmp, join(this.options.store, `${stem}.answer`));
    } catch {
      // The store is gone — the run is being torn down. The hook's own bound handles the rest.
    }
  }
}
