import "server-only";
import {
  CommonErrorCode,
  type CriterionExplanationDto,
  type ExplainCriterionInput,
  ExplainErrorCode,
  err,
  ok,
  type Result,
  type ReviewCriterionDto,
  type SessionEventPayload,
} from "@solow/contracts";
import { orchestrator } from "../orchestrator-client.js";
import type { RequestContext } from "./context.js";
import { getIssueById } from "./issue.js";
import { getReviewBrief } from "./review-brief.js";
import { getSessionById, listSessionEvents } from "./session.js";
import { getTaskById } from "./task.js";

/**
 * "Explain this criterion to me" (Brief tab).
 *
 * The reader is at the gate and does not read code: a product owner asked to sign off on
 * `assessExtraction(input): ExtractionVerdict lives in apps/crawler/src/web-extract/`. The
 * criterion is right, and it is not for them. This asks the Task's own harness to say what it
 * means in the reader's own terms — and, so the explanation never drifts from what was
 * actually done, hands it the harness's own account: its claim about the criterion, its
 * closing summary, and the turns in the run log where it spoke about that criterion by name.
 * It is told to stay inside that material and to say when the harness said nothing.
 *
 * **The Task's harness, not an API client.** The answer comes from the same binary, credential
 * and model the Task ran under — the orchestrator drives one print turn of it (`POST /explain`,
 * see `harness/explain.ts` there). The web layer never holds a harness credential; the
 * orchestrator has the one entry point that yields it, and it is the one that pays.
 *
 * **Kept for a day.** One answer per criterion and language is held in memory: a second press,
 * or a reload, costs nothing and reads the same. Per process, not per replica — the cost of a
 * miss is one turn of the harness.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

const cache = new Map<string, { text: string; model: string | null; at: number }>();

const SYSTEM = `You explain one acceptance criterion of a software task to a reader who does not read code — a product owner or a business stakeholder deciding whether to accept the work.

You are given: the criterion; the task's title and the Issue's description; and your own account of the run — the claim about this criterion, the closing summary, and the turns where the criterion was spoken about. Stay inside that material. Where the account says nothing about the criterion, say so plainly; never invent what was done. Do not read files or run tools: everything you need is in the message.

Write in the reader's language, given below. Keep identifiers, file names, commands and code exactly as written — do not translate or paraphrase them, but explain around them.

Answer in Markdown, without a title, in this order, each part short:
1. **What it means** — the criterion in plain words, two or three sentences, no jargon.
2. **Why it matters** — the business or user consequence of getting it right or wrong, one or two sentences.
3. **What the harness says it did** — from the claim and the account, one to three sentences; say what remains unverified.
4. **One thing to check** — a single concrete question the reader could ask or look at to be sure.

About 150 to 220 words in total. Answer with the explanation only.`;

/** The events the harness is shown back: its closing words and what it said about the criterion. */
function gatherAccount(
  events: ReadonlyArray<{ payload: unknown }>,
  criterion: ReviewCriterionDto,
): { mentions: string[]; lastTurn: string | null } {
  const idPattern = new RegExp(criterion.id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i");
  const mentions: string[] = [];
  let lastTurn: string | null = null;
  for (const event of events) {
    const payload = event.payload as SessionEventPayload;
    if (payload.kind !== "assistant_turn" || payload.thinking) continue;
    lastTurn = payload.text;
    if (idPattern.test(payload.text)) mentions.push(payload.text);
  }
  // Bounded on both counts: the last three mentions, each clipped, and the closing turn clipped.
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)} […]` : text;
  return {
    mentions: mentions.slice(-3).map((text) => clip(text, 1500)),
    lastTurn: lastTurn ? clip(lastTurn, 1500) : null,
  };
}

export async function explainCriterion(
  ctx: RequestContext,
  input: ExplainCriterionInput,
): Promise<
  Result<
    CriterionExplanationDto,
    | typeof CommonErrorCode.NotFound
    | typeof CommonErrorCode.RateLimited
    | (typeof ExplainErrorCode)[keyof typeof ExplainErrorCode]
  >
> {
  const brief = await getReviewBrief(ctx, input.sessionId);
  if (!brief.ok) return err(CommonErrorCode.NotFound);
  const criterion = brief.data.criteria.find((c) => c.id === input.criterionId);
  if (!criterion) return err(CommonErrorCode.NotFound);

  const key = `${ctx.workspaceId}:${input.sessionId}:${criterion.id}:${input.language}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return ok({ criterionId: criterion.id, text: hit.text, model: hit.model, cached: true });
  }

  const session = await getSessionById(ctx, input.sessionId);
  if (!session.ok) return err(CommonErrorCode.NotFound);
  const task = await getTaskById(ctx, session.data.taskId, { includeDeleted: true });
  if (!task.ok) return err(CommonErrorCode.NotFound);
  const issue = await getIssueById(ctx, task.data.issueId);
  const events = await listSessionEvents(ctx, input.sessionId);
  const account = gatherAccount(events.ok ? events.data : [], criterion);

  const parts: string[] = [
    `Reader's language: ${input.language}`,
    "",
    `# Criterion ${criterion.id}`,
    criterion.text,
    "",
    "# Task",
    `Title: ${task.data.title}`,
    issue.ok && issue.data.description
      ? `Issue description:\n${issue.data.description.slice(0, 4000)}`
      : "Issue description: (none)",
    "",
    "# Your account of the run",
    criterion.claim
      ? `Claim about this criterion: ${criterion.claim.state} — ${criterion.claim.label}${criterion.claim.note ? ` (${criterion.claim.note})` : ""}`
      : "Claim about this criterion: none — the checklist did not mention it.",
    criterion.files.length > 0
      ? `Files the claim names: ${criterion.files.join(", ")}`
      : "Files the claim names: none",
    criterion.tests.length > 0 ? `Tests named: ${criterion.tests.join(", ")}` : "Tests named: none",
    task.data.completedSummary
      ? `Closing summary: ${task.data.completedSummary}`
      : "Closing summary: (the run has not reported one)",
    ...(account.mentions.length > 0
      ? [
          "",
          "What was said about this criterion during the run:",
          ...account.mentions.map((m) => `---\n${m}`),
        ]
      : ["", "The run's turns never name this criterion."]),
    ...(account.lastTurn ? ["", "The last words of the run:", account.lastTurn] : []),
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
    // Unwired, unreachable, or a refused request: the harness could not be asked at all.
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
  return ok({ criterionId: criterion.id, text: report.text, model: report.model, cached: false });
}
