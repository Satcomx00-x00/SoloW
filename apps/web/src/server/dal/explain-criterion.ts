import "server-only";
import Anthropic from "@anthropic-ai/sdk";
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
import { decryptForCriterionExplanation, harnessProfile, secret } from "@solow/db";
import { and, eq } from "drizzle-orm";
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
 * criterion is right, and it is not for them. This asks a model to say what it means in the
 * reader's own terms — and, so the explanation never drifts from what was actually done, hands
 * it the harness's own account: its claim about the criterion, its closing summary, and the
 * turns in the run log where it spoke about that criterion by name. The model is told to stay
 * inside that material and to say when the harness said nothing.
 *
 * **Whose credential.** The Harness Profile the Task ran under holds a Secret; when it is an
 * `api_key` the explanation is billed to the same credential as the run it explains, through
 * the secret store's third purpose-named entry point. A `subscription_token` is a Claude Code
 * subscription and is not for API calls, so it is never used here; the server's own
 * `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (the SDK's default resolution) is the fallback,
 * and with neither the ask
 * is refused with a code the UI turns into "attach an API key to the harness profile".
 *
 * **Kept for a day.** One answer per criterion and language is held in memory: a second press,
 * or a reload, costs nothing and reads the same. Per process, not per replica — the cost of a
 * miss is one call.
 */

const MODEL = "claude-opus-5";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

const cache = new Map<string, { text: string; model: string; at: number }>();

const SYSTEM = `You explain one acceptance criterion of a software task to a reader who does not read code — a product owner or a business stakeholder deciding whether to accept the work.

You are given: the criterion; the task's title and the Issue's description; and the harness's own account of its run — its claim about this criterion, its closing summary, and the turns where it spoke about the criterion. Stay inside that material. Where the harness said nothing about the criterion, say so plainly; never invent what was done.

Write in the reader's language, given below. Keep identifiers, file names, commands and code exactly as written — do not translate or paraphrase them, but explain around them.

Answer in Markdown, without a title, in this order, each part short:
1. **What it means** — the criterion in plain words, two or three sentences, no jargon.
2. **Why it matters** — the business or user consequence of getting it right or wrong, one or two sentences.
3. **What the harness says it did** — from its claim and its words, one to three sentences; say what remains unverified.
4. **One thing to check** — a single concrete question the reader could ask or look at to be sure.

About 150 to 220 words in total.`;

/** The events the model is shown: the closing summary and the harness's own words on the criterion. */
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

/**
 * The credential to ask with: the Task's Harness Profile Secret when it is an API key, else
 * the server's own (`null` leaves the SDK to resolve `ANTHROPIC_API_KEY`), else nothing.
 */
async function credentialFor(
  ctx: RequestContext,
  agentProfileId: string,
): Promise<Result<string | null, typeof ExplainErrorCode.NoCredential>> {
  const [row] = await ctx.db
    .select({ kind: secret.kind, ciphertext: secret.ciphertext })
    .from(harnessProfile)
    .innerJoin(secret, eq(secret.id, harnessProfile.secretId))
    .where(
      and(eq(harnessProfile.workspaceId, ctx.workspaceId), eq(harnessProfile.id, agentProfileId)),
    )
    .limit(1);
  if (row?.kind === "api_key") return ok(decryptForCriterionExplanation(row.ciphertext));
  // Either of the two the SDK resolves on its own: a key, or a bearer token from `ant auth login`.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return ok(null);
  return err(ExplainErrorCode.NoCredential);
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

  const credential = await credentialFor(ctx, task.data.agentProfileId);
  if (!credential.ok) return credential;

  const parts: string[] = [
    `Reader's language: ${input.language}`,
    "",
    `# Criterion ${criterion.id}`,
    criterion.text,
    "",
    `# Task`,
    `Title: ${task.data.title}`,
    issue.ok && issue.data.description
      ? `Issue description:\n${issue.data.description.slice(0, 4000)}`
      : "Issue description: (none)",
    "",
    "# The harness's account",
    criterion.claim
      ? `Claim about this criterion: ${criterion.claim.state} — ${criterion.claim.label}${criterion.claim.note ? ` (${criterion.claim.note})` : ""}`
      : "Claim about this criterion: none — the harness did not mention it in its checklist.",
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
          "What the harness said about this criterion during the run:",
          ...account.mentions.map((m) => `---\n${m}`),
        ]
      : ["", "The harness's turns never name this criterion."]),
    ...(account.lastTurn ? ["", "The harness's last words in the run:", account.lastTurn] : []),
  ];

  const client = new Anthropic(credential.data ? { apiKey: credential.data } : {});
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // A policy decline is re-run on a fallback model inside the same call, routed by category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // A short explanation of given material: low effort is the right spend for it.
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: parts.join("\n") }],
    });
    if (response.stop_reason === "refusal") return err(ExplainErrorCode.Refused);
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) return err(ExplainErrorCode.Upstream);
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { text, model: response.model, at: Date.now() });
    return ok({ criterionId: criterion.id, text, model: response.model, cached: false });
  } catch (error) {
    // Most specific first: the credential, the quota, then anything else the API said or the
    // network did. Never the message text — it can carry the request, never the key, but the
    // code is what the UI turns into a sentence.
    if (error instanceof Anthropic.AuthenticationError) return err(ExplainErrorCode.BadCredential);
    if (error instanceof Anthropic.RateLimitError) return err(CommonErrorCode.RateLimited);
    if (error instanceof Anthropic.APIError || error instanceof Anthropic.APIConnectionError) {
      return err(ExplainErrorCode.Upstream);
    }
    throw error;
  }
}
