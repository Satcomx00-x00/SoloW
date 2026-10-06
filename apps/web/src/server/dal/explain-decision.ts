import "server-only";
import {
  CommonErrorCode,
  type DecisionExplanationDto,
  type DecisionWidget,
  type ExplainDecisionInput,
  ExplainErrorCode,
  err,
  ok,
  type Result,
  type SessionEventPayload,
} from "@solow/contracts";
import { orchestrator } from "../orchestrator-client.js";
import type { RequestContext } from "./context.js";
import { getIssueById } from "./issue.js";
import { getSessionById, listSessionEvents } from "./session.js";
import { getTaskById } from "./task.js";

/**
 * "Explain to me" on a decision the harness made (the board's decisions dialog).
 *
 * The same shape as `explain-criterion.ts`, and for its reasons: asked of the Task's own harness
 * through the orchestrator's `/explain`, anchored in the run's own record, billed — so asked on
 * the press and kept a day — and never written into the record. What differs is the material:
 * the decision itself (the question, every option the harness weighed and why, the one it took),
 * the task, and what the run said about it.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { text: string; model: string | null; at: number }>();

const SYSTEM = `You explain one decision an AI coding agent made while working on a software task, to the person who must confirm or overturn it. They may not read code.

You are given: the decision — its question, every option that was weighed with the reason given for it, and the option the agent picked; the task's title and the Issue's description; and the agent's own account of the run. Stay inside that material; never invent what was done. Do not read files or run tools: everything you need is in the message.

Write in the reader's language, given below. Keep identifiers, file names, commands and code exactly as written.

Answer in Markdown, without a title, in this order, each part short:
1. **What is being decided** — the question in plain words, two sentences at most.
2. **The options** — one line per option: what choosing it would mean in practice, and its main risk.
3. **Why the agent picked its option** — from its reason; say if the reason is thin.
4. **What to weigh** — the one or two things the reader should consider before confirming.

About 150 to 250 words in total. Answer with the explanation only.`;

function latestDecision(
  events: ReadonlyArray<{ payload: unknown }>,
  decisionId: string,
): DecisionWidget | null {
  let found: DecisionWidget | null = null;
  for (const event of events) {
    const payload = event.payload as SessionEventPayload;
    if (
      payload.kind === "widget" &&
      payload.widget.kind === "decision" &&
      payload.widget.id === decisionId
    )
      found = payload.widget;
  }
  return found;
}

function lastAssistantTurn(events: ReadonlyArray<{ payload: unknown }>): string | null {
  let last: string | null = null;
  for (const event of events) {
    const payload = event.payload as SessionEventPayload;
    if (payload.kind === "assistant_turn" && !payload.thinking) last = payload.text;
  }
  return last && last.length > 1500 ? `${last.slice(0, 1500)} […]` : last;
}

export async function explainDecision(
  ctx: RequestContext,
  input: ExplainDecisionInput,
): Promise<
  Result<
    DecisionExplanationDto,
    typeof CommonErrorCode.NotFound | (typeof ExplainErrorCode)[keyof typeof ExplainErrorCode]
  >
> {
  const session = await getSessionById(ctx, input.sessionId);
  if (!session.ok) return err(CommonErrorCode.NotFound);
  const events = await listSessionEvents(ctx, input.sessionId);
  const decision = latestDecision(events.ok ? events.data : [], input.decisionId);
  if (!decision) return err(CommonErrorCode.NotFound);

  const key = `${ctx.workspaceId}:${input.sessionId}:${decision.id}:${input.language}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return ok({ decisionId: decision.id, text: hit.text, model: hit.model, cached: true });
  }

  const task = await getTaskById(ctx, session.data.taskId, { includeDeleted: true });
  if (!task.ok) return err(CommonErrorCode.NotFound);
  const issue = await getIssueById(ctx, task.data.issueId);
  const lastTurn = lastAssistantTurn(events.ok ? events.data : []);

  const parts: string[] = [
    `Reader's language: ${input.language}`,
    "",
    "# The decision",
    `Question: ${decision.question}`,
    "Options:",
    ...decision.options.map(
      (o) =>
        `- ${o.label}${o.id === decision.chosen ? " (the agent's pick)" : ""}${o.why ? ` — ${o.why}` : ""}`,
    ),
    decision.reason ? `The agent's reason: ${decision.reason}` : "The agent gave no reason.",
    "",
    "# Task",
    `Title: ${task.data.title}`,
    issue.ok && issue.data.description
      ? `Issue description:\n${issue.data.description.slice(0, 4000)}`
      : "Issue description: (none)",
    "",
    "# The agent's account",
    task.data.completedSummary
      ? `Closing summary: ${task.data.completedSummary}`
      : "Closing summary: (the run has not reported one)",
    ...(lastTurn ? ["", "The last words of the run:", lastTurn] : []),
  ];

  let report: Awaited<ReturnType<typeof orchestrator.explainWithHarness>>;
  try {
    report = await orchestrator.explainWithHarness({
      workspaceId: ctx.workspaceId,
      taskId: task.data.id,
      system: SYSTEM,
      prompt: parts.join("\n"),
    });
  } catch {
    return err(ExplainErrorCode.Upstream);
  }
  if (!report.ok || !report.text) {
    return err(
      report.failure === "credential" ? ExplainErrorCode.NoCredential : ExplainErrorCode.Upstream,
    );
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { text: report.text, model: report.model, at: Date.now() });
  return ok({ decisionId: decision.id, text: report.text, model: report.model, cached: false });
}
