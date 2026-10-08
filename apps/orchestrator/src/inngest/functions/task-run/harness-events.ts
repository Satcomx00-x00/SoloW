import { type SessionEventPayload, type TodoItem, todoItemSchema } from "@solow/contracts";
import { z } from "zod";
import type { HarnessTextChannel } from "../../../harness/runner.js";

/*
 * What a harness says, made fit for the durable log: the record a line of output becomes, which
 * of a tool call's arguments may be kept, how much of its output, a todo list read out of a
 * `TodoWrite`, and this run's own secrets taken out of every payload (Principle IV).
 */

/**
 * What a line of harness output *is*, from the channel the protocol reported it on.
 *
 * The mapping is the whole point of carrying the channel this far: without it every line was a
 * `stdout` blob and the transcript could not distinguish the operator's own steering from the
 * model's answer from a mode switch (issue #2, AC-1).
 */
export function textPayload(channel: HarnessTextChannel, text: string): SessionEventPayload {
  if (channel === "user") return { kind: "user_turn", text };
  if (channel === "system") return { kind: "notice", text };
  return { kind: "assistant_turn", text, thinking: channel === "thinking" };
}

/**
 * Which of a tool's arguments may be written to the durable log, by tool name.
 *
 * A tool call's raw input can hold the contents of a file being written, which is exactly the
 * class of value that must never reach a durable payload (Principle IV) — so the schema declared
 * `tool_call.input` and left it unpopulated for a long time. The cost was a transcript that
 * could only ever say "tool: Read": a reviewer could not see which file, which command, or which
 * pattern, which is most of what makes a tool call worth reading.
 *
 * The resolution is an allowlist of *keys*, not a size limit or a redaction pass over everything.
 * A denylist would be wrong here: it fails open, so a tool added upstream with a new
 * content-bearing argument would start leaking the day it shipped. This fails closed — an
 * unknown tool contributes no arguments at all.
 *
 * `Write.content` and `Edit.new_string` are absent on purpose and must stay absent. They are the
 * file contents.
 */
const TOOL_INPUT_ALLOWLIST: Record<string, readonly string[]> = {
  Read: ["file_path", "offset", "limit"],
  Write: ["file_path"],
  Edit: ["file_path", "replace_all"],
  NotebookEdit: ["notebook_path", "cell_id"],
  Bash: ["command", "description", "timeout"],
  BashOutput: ["bash_id"],
  KillShell: ["shell_id"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob", "type"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["description", "subagent_type"],
  // Nothing here, and nothing that could be: a todo list is an array of objects and this map
  // holds short strings. A well-formed `TodoWrite` never reaches this function at all — it is
  // recorded as a `todos` event instead (see `readTodoWrite`) — so what this entry now governs
  // is only the fallback row a malformed one falls through to.
  TodoWrite: [],
};

/**
 * ACP reports a tool call's status as a free-form string; the log stores a closed set. An
 * unrecognised value becomes null rather than being stored raw — a status nothing can render is
 * worse than none, and a future ACP vocabulary must not be able to widen the persisted union by
 * writing into it.
 */
const TOOL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
type ToolStatus = (typeof TOOL_STATUSES)[number];
export function toolStatus(value: string | null): ToolStatus | null {
  return TOOL_STATUSES.includes(value as ToolStatus) ? (value as ToolStatus) : null;
}

/** Longest an allowlisted argument may be before it is cut. A command is a line, not a file. */
const TOOL_INPUT_MAX = 400;

/** Longest a tool's output may be before it is cut, with `truncated` set to say so. */
const TOOL_OUTPUT_MAX = 2_000;

/**
 * A tool call's arguments, narrowed to what may be stored.
 *
 * Values are stringified and cut to `TOOL_INPUT_MAX`, so the stored shape is always a flat map
 * of short strings — the guarantee `sessionEventPayloadSchema` encodes with `z.record(z.string())`.
 * Returns null rather than an empty object for a tool that contributes nothing, so a reader can
 * tell "no arguments recorded" from "arguments recorded, and there were none".
 */
export function allowlistToolInput(name: string, input: unknown): Record<string, string> | null {
  const keys = TOOL_INPUT_ALLOWLIST[name];
  if (!keys || keys.length === 0) return null;
  if (typeof input !== "object" || input === null) return null;

  const source = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    out[key] = text.length > TOOL_INPUT_MAX ? `${text.slice(0, TOOL_INPUT_MAX)}…` : text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * How many todo items and how much of each one the log will hold.
 *
 * The same numbers `todoItemSchema` enforces, restated here because this is the side that has to
 * *make* the payload fit: a list that overshoots the bound is cut down to it rather than
 * refused. Refusing would mean falling back to the `TodoWrite` tool call, which is precisely the
 * contentless row recording the list exists to remove.
 */
const TODO_ITEMS_MAX = 100;
const TODO_TEXT_MAX = 500;

/** Cut a todo's text to the schema's bound, leaving the marker inside it rather than over it. */
function boundTodoText(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= TODO_TEXT_MAX) return value;
  return `${value.slice(0, TODO_TEXT_MAX - 1)}…`;
}

/**
 * The todo list out of a `TodoWrite` call, or null when the input is not one.
 *
 * Pure and exported so it can be tested without a run: this is the only thing standing between
 * a harness's plan and the durable log, and its two failure modes pull in opposite directions —
 * too strict and the list is silently replaced by the contentless tool-call row it was meant to
 * abolish, too loose and an unbounded blob reaches a record that outlives the run.
 *
 * So the bounds are applied first and the shape is checked second. An over-long list is cut and
 * kept; a list whose items are not todos at all is refused, and the caller falls back to
 * emitting the tool call — an emission this file cannot understand is degraded, never dropped.
 */
export function readTodoWrite(input: unknown): TodoItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const todos = (input as Record<string, unknown>)["todos"];
  if (!Array.isArray(todos)) return null;

  const bounded = todos.slice(0, TODO_ITEMS_MAX).map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const fields = item as Record<string, unknown>;
    const out: Record<string, unknown> = { ...fields, content: boundTodoText(fields["content"]) };
    if (fields["activeForm"] !== undefined) out["activeForm"] = boundTodoText(fields["activeForm"]);
    return out;
  });

  const parsed = z.array(todoItemSchema).safeParse(bounded);
  return parsed.success ? parsed.data : null;
}

/**
 * A tool's output, cut to a length a transcript can hold.
 *
 * Compaction will not save the log from an untruncated one: `SESSION_COMPACTION_THRESHOLD`
 * counts events, not bytes, and only runs at a review-round boundary — so a single `Read` of a
 * large file would sit in the log whole until then.
 */
export function truncateToolOutput(output: string | null): {
  output: string | null;
  truncated: boolean;
} {
  if (output === null) return { output: null, truncated: false };
  if (output.length <= TOOL_OUTPUT_MAX) return { output, truncated: false };
  return { output: `${output.slice(0, TOOL_OUTPUT_MAX)}…`, truncated: true };
}

/** What a redacted secret leaves behind, so a reader can see that something was removed. */
const REDACTED = "[redacted]";

/**
 * Values this run holds that must never end up in a payload (Principle IV, issue #2 DoD).
 *
 * The needles are exact strings — the decrypted credential as it was written into the harness's
 * environment, and the ciphertext it was decrypted from — rather than a pattern that guesses at
 * what a token looks like. The realistic path a secret takes into the log is the harness echoing
 * its own environment: `echo $ANTHROPIC_API_KEY`, a config dump, a stack trace that prints a
 * header. All of those carry the value verbatim, so an exact match catches them, while a
 * heuristic would both miss real keys and mangle innocent text.
 *
 * Anything shorter than eight characters is left alone: it is not a credential, and redacting a
 * short string would replace ordinary words all over a transcript.
 */
export function secretNeedles(
  env: Readonly<Record<string, string>>,
  catalog: { subscriptionEnvVar: string; meteredEnvVar: string },
  ciphertext: string | null,
): string[] {
  const candidates = [env[catalog.subscriptionEnvVar], env[catalog.meteredEnvVar], ciphertext];
  return [
    ...new Set(candidates.filter((v): v is string => typeof v === "string" && v.length >= 8)),
  ];
}

/** Replace every occurrence of each needle in every string the value holds, however deep. */
function redactValue(value: unknown, needles: readonly string[]): unknown {
  if (typeof value === "string") {
    return needles.reduce((text, needle) => text.split(needle).join(REDACTED), value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, needles));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([k, v]) => [k, redactValue(v, needles)]));
  }
  return value;
}

/**
 * A record with this run's own secrets stripped out of it.
 *
 * Applied to the whole payload rather than to the text variants alone: the log is the record
 * that outlives the run and travels — into a snapshot (#16), into a harness's context (#84) — and
 * a future producer that populates `tool_call.input` should inherit the protection rather than
 * have to remember it. `kind` is put back verbatim so a needle can never rewrite the
 * discriminator itself.
 */
export function redactPayload(
  payload: SessionEventPayload,
  needles: readonly string[],
): SessionEventPayload {
  if (needles.length === 0) return payload;
  const scrubbed = redactValue(payload, needles) as Record<string, unknown>;
  return { ...scrubbed, kind: payload.kind } as SessionEventPayload;
}
