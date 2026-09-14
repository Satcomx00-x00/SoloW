"use client";

import type { ReviewCheckDto, ReviewCriterionDto } from "@solow/contracts";
import { CommonErrorCode, ExplainErrorCode } from "@solow/contracts";
import {
  Check,
  CircleDashed,
  CircleHelp,
  FlaskConical,
  MapPinOff,
  MessageCircleQuestion,
  OctagonMinus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { HarnessMarkdown } from "./markdown";

/**
 * The Review tab (review analysis, point 1): the one view that answers "may I sign this".
 *
 * Three things the page held apart are lined up per acceptance criterion — what the Issue asked,
 * what the harness claims it did (its `step_card`, item by item), and what the change and the
 * run offer as evidence: the files the claim names, the tests it names, and whether any test
 * actually ran. Each row ends in the reviewer's own tick, kept in their draft, because the
 * harness's "done" is a claim and the tick is the only column here that is a fact.
 *
 * Below it, every verification the run executed — a `bun test`, a typecheck, a lint — with the
 * verdict read out of its output and *where* it ran. The harness of the Task this was written
 * for ran its suite from a copy in `/tmp` and reported the numbers as the worktree's; a check
 * run elsewhere is flagged, not hidden.
 */
export function ReviewBriefPanel({
  sessionId,
  openItems,
  verified,
  onToggleVerified,
  canVerify,
}: {
  sessionId: string;
  openItems: ReadonlyArray<{ label: string; why: string | null }>;
  verified: readonly string[];
  onToggleVerified: (criterionId: string) => void;
  /** False on an older round or a Task not at its gate — the brief is read, not signed. */
  canVerify: boolean;
}) {
  const brief = trpc.session.reviewBrief.useQuery({ sessionId });

  if (brief.isLoading) {
    return (
      <div className="space-y-2" aria-hidden>
        <div className="h-10 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
      </div>
    );
  }
  if (!brief.data) {
    return <p className="text-muted-foreground text-xs">The review brief could not be read.</p>;
  }
  const { criteria, checks, unmatched, worktreePath } = brief.data;
  const done = criteria.filter((c) => verified.includes(c.id)).length;
  const claimed = criteria.filter((c) => c.claim?.state === "done").length;
  const lastTest = [...checks].reverse().find((c) => c.kind === "test") ?? null;

  return (
    <div className="space-y-4" data-review-brief>
      {openItems.length > 0 ? (
        <section
          aria-label="Open items"
          className="rounded-lg border border-feedback-caution/40 bg-feedback-caution/10 px-3 py-2 text-xs"
        >
          <p className="flex items-center gap-1.5 font-medium text-feedback-caution">
            <CircleDashed aria-hidden className="size-3.5 shrink-0" />
            {openItems.length === 1 ? "1 open item" : `${openItems.length} open items`} the harness
            left undone
          </p>
          <ul className="mt-1 space-y-0.5 pl-5">
            {openItems.map((item) => (
              <li key={item.label} className="list-disc">
                <span className="font-medium">{item.label}</span>
                {item.why ? <span className="text-muted-foreground"> — {item.why}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Acceptance criteria" className="space-y-2">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-sm">Acceptance criteria</h2>
          <p className="text-2xs text-muted-foreground">
            {criteria.length === 0
              ? "The issue lists none."
              : `${claimed} of ${criteria.length} claimed done by the harness · ${done} of ${criteria.length} verified by you`}
          </p>
        </header>
        {criteria.length === 0 ? (
          <p className="surface-edge rounded-lg border bg-card px-3 py-2 text-2xs text-muted-foreground">
            No `- [ ] **AC-n**` lines in the issue, so there is nothing to line the claims up
            against. The harness's own checklist is below.
          </p>
        ) : (
          <ol className="space-y-1.5">
            {criteria.map((criterion) => (
              <CriterionRow
                key={criterion.id}
                sessionId={sessionId}
                criterion={criterion}
                lastTest={lastTest}
                verified={verified.includes(criterion.id)}
                onToggle={() => onToggleVerified(criterion.id)}
                canVerify={canVerify}
              />
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Verifications" className="space-y-2">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium text-sm">Verifications the run executed</h2>
          {worktreePath ? (
            <p className="truncate font-mono text-2xs text-muted-foreground" title={worktreePath}>
              worktree {worktreePath.slice(worktreePath.lastIndexOf("/") + 1)}
            </p>
          ) : null}
        </header>
        {checks.length === 0 ? (
          <p className="surface-edge rounded-lg border bg-card px-3 py-2 text-2xs text-feedback-caution">
            No test, lint or typecheck was run. Whatever the summary says, nothing here was
            verified.
          </p>
        ) : (
          <ul className="space-y-1">
            {checks.map((check, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a check is positional in the log; the list is never reordered
              <CheckRow key={index} check={check} />
            ))}
          </ul>
        )}
      </section>

      {unmatched.length > 0 ? (
        <section aria-label="Harness checklist" className="space-y-1.5">
          <h2 className="font-medium text-sm">
            The harness's own items{" "}
            <span className="font-normal text-2xs text-muted-foreground">(no criterion named)</span>
          </h2>
          <ul className="space-y-0.5 text-xs">
            {unmatched.map((claim) => (
              <li key={claim.label} className="flex items-start gap-1.5">
                <ClaimIcon state={claim.state} />
                <span>
                  {claim.label}
                  {claim.note ? (
                    <span className="text-muted-foreground"> — {claim.note}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const CLAIM_STYLE = {
  done: { icon: Check, tone: "text-feedback-ok", label: "claimed done" },
  active: { icon: CircleDashed, tone: "text-state-running", label: "in progress" },
  todo: { icon: CircleDashed, tone: "text-muted-foreground", label: "not done" },
  blocked: { icon: OctagonMinus, tone: "text-feedback-caution", label: "blocked" },
} as const;

function ClaimIcon({ state }: { state: keyof typeof CLAIM_STYLE }) {
  const { icon: Icon, tone, label } = CLAIM_STYLE[state];
  return <Icon aria-label={label} className={cn("mt-0.5 size-3.5 shrink-0", tone)} />;
}

function CriterionRow({
  sessionId,
  criterion,
  lastTest,
  verified,
  onToggle,
  canVerify,
}: {
  sessionId: string;
  criterion: ReviewCriterionDto;
  lastTest: ReviewCheckDto | null;
  verified: boolean;
  onToggle: () => void;
  canVerify: boolean;
}) {
  const claim = criterion.claim;
  const ex = useExplainCriterion(sessionId, criterion);
  // The evidence line: the test the claim names, and whether a test check ran at all — and if
  // it did, where. "NOT executed here" inside a note is what this row exists to make visible.
  const notExecuted = /not (executed|run)|unexecuted/i.test(claim?.note ?? "");
  return (
    <li
      className={cn(
        "surface-edge grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs",
        verified && "border-feedback-ok/40",
      )}
      data-criterion={criterion.id}
    >
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <Checkbox
          aria-label={`Verified ${criterion.id} myself`}
          checked={verified}
          disabled={!canVerify}
          onCheckedChange={onToggle}
        />
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1">
            <span className="mr-1.5 rounded bg-muted px-1 font-mono text-2xs">{criterion.id}</span>
            <span className={cn(verified && "text-muted-foreground")}>{criterion.text}</span>
          </p>
          <ExplainButton ex={ex} criterion={criterion} />
        </div>
        <p className="flex items-start gap-1.5 text-2xs">
          {claim ? (
            <>
              <ClaimIcon state={claim.state} />
              <span className="min-w-0">
                <span className="font-medium">{CLAIM_STYLE[claim.state].label}</span>
                {claim.note ? <span className="text-muted-foreground"> — {claim.note}</span> : null}
              </span>
            </>
          ) : (
            <>
              <CircleHelp
                aria-label="no claim"
                className="mt-0.5 size-3.5 shrink-0 text-feedback-caution"
              />
              <span className="font-medium text-feedback-caution">
                The harness made no claim about this criterion.
              </span>
            </>
          )}
        </p>
        {criterion.files.length > 0 ? (
          <p className="flex flex-wrap gap-1">
            {criterion.files.map((path) => (
              <span
                key={path}
                className="rounded border bg-background/60 px-1 font-mono text-[10px] text-muted-foreground"
                title={path}
              >
                {path.slice(path.lastIndexOf("/") + 1)}
              </span>
            ))}
          </p>
        ) : null}
        {criterion.tests.length > 0 ? (
          <p className="flex items-center gap-1.5 text-2xs">
            <FlaskConical aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            {notExecuted || !lastTest ? (
              <span className="text-feedback-caution">
                Test named, <span className="font-medium">not executed</span>
                {lastTest ? " for this criterion" : " — no test run in this session"}.
              </span>
            ) : (
              <span className={cn(lastTest.passed === false && "text-feedback-error")}>
                Tests ran: {lastTest.verdict}
                {lastTest.elsewhere ? " — in a copy, not this worktree" : ""}.
              </span>
            )}
          </p>
        ) : null}
        <ExplanationBlock ex={ex} criterion={criterion} />
      </div>
    </li>
  );
}

const CHECK_LABEL: Record<ReviewCheckDto["kind"], string> = {
  test: "tests",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
  audit: "audit",
};

function CheckRow({ check }: { check: ReviewCheckDto }) {
  const Verdict = check.passed === true ? Check : check.passed === false ? X : CircleHelp;
  return (
    <li
      className="surface-edge flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border bg-card px-3 py-1.5 text-xs"
      data-check={check.kind}
    >
      <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-16 shrink-0 font-medium">{CHECK_LABEL[check.kind]}</span>
      <span
        className={cn(
          "inline-flex items-center gap-1 font-mono text-2xs",
          check.passed === true && "text-feedback-ok",
          check.passed === false && "text-feedback-error",
          check.passed === null && "text-muted-foreground",
        )}
      >
        <Verdict aria-hidden className="size-3" />
        {check.verdict}
      </span>
      {check.elsewhere ? (
        <span className="inline-flex items-center gap-1 text-2xs text-feedback-caution">
          <MapPinOff aria-hidden className="size-3" />
          ran in {check.cwd} — not this worktree
        </span>
      ) : null}
      <span className="ml-auto text-2xs text-muted-foreground">{relativeAge(check.at)}</span>
      <code
        className="w-full truncate font-mono text-[10px] text-muted-foreground"
        title={check.command}
      >
        {check.command}
      </code>
      {check.passed === null && check.verdict === "no result" ? (
        <span className="inline-flex items-center gap-1 text-2xs text-feedback-caution">
          <TriangleAlert aria-hidden className="size-3" /> no result came back
        </span>
      ) : null}
    </li>
  );
}

/** What the ask can say when it fails, in words — the code is never shown. */
const EXPLAIN_MESSAGE: Record<string, string> = {
  [ExplainErrorCode.NoCredential]:
    "No API key to ask with. Attach an api_key Secret to this task's harness profile, or set ANTHROPIC_API_KEY on the server.",
  [ExplainErrorCode.BadCredential]: "The API refused the harness profile's key.",
  [ExplainErrorCode.Refused]: "The model declined to explain this one.",
  [ExplainErrorCode.Upstream]: "The model could not be reached. Try again in a moment.",
  [CommonErrorCode.RateLimited]: "Rate limited — try again in a moment.",
};

/**
 * "Explain" on a criterion: a plain-language reading of it, for someone who does not read
 * code, anchored in the harness's own account of the run (see dal/explain-criterion.ts).
 *
 * Asked on the press, never on render — it is billed — and asked once: the answer is held here
 * for the life of the panel and on the server for a day, so the button then only folds the
 * text away and back. Written in the reader's language (`navigator.language`); the criterion's
 * identifiers stay as they are. The button sits on the criterion's line; the text lands under
 * it, where the eye goes next — so the state lives in this hook and the row draws both.
 */
function useExplainCriterion(sessionId: string, criterion: ReviewCriterionDto) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const explain = trpc.session.explainCriterion.useMutation();
  const language = typeof navigator === "undefined" ? "en" : navigator.language;
  const ask = () => {
    setOpen(true);
    if (explain.data || explain.isPending) return;
    explain.mutate({ sessionId, criterionId: criterion.id, language });
  };
  const shown = open && Boolean(explain.data);
  const message = explain.error
    ? (EXPLAIN_MESSAGE[explain.error.message] ?? EXPLAIN_MESSAGE[ExplainErrorCode.Upstream])
    : null;
  return {
    panelId,
    shown,
    pending: explain.isPending,
    data: explain.data ?? null,
    message,
    toggle: shown ? () => setOpen(false) : ask,
    retry: () => explain.mutate({ sessionId, criterionId: criterion.id, language }),
  };
}

type Explanation = ReturnType<typeof useExplainCriterion>;

function ExplainButton({ ex, criterion }: { ex: Explanation; criterion: ReviewCriterionDto }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      className="-my-0.5 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={ex.shown ? `Hide the explanation of ${criterion.id}` : `Explain ${criterion.id}`}
      aria-expanded={ex.shown}
      aria-controls={ex.data ? ex.panelId : undefined}
      loading={ex.pending}
      onClick={ex.toggle}
    >
      <MessageCircleQuestion aria-hidden />
      {ex.shown ? "Hide" : "Explain"}
    </Button>
  );
}

/** Said under the text: which model wrote it, and that it is a reading of the record, not part of it. */
function ExplanationBlock({ ex, criterion }: { ex: Explanation; criterion: ReviewCriterionDto }) {
  if (ex.message) {
    return (
      <p className="flex items-center gap-2 text-2xs text-feedback-error" role="alert">
        <span className="min-w-0 flex-1">{ex.message}</span>
        <button
          type="button"
          className="shrink-0 underline underline-offset-2 hover:text-foreground"
          onClick={ex.retry}
        >
          Try again
        </button>
      </p>
    );
  }
  if (!ex.shown || !ex.data) return null;
  return (
    <div
      id={ex.panelId}
      className="space-y-2 rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed transition-opacity duration-150 starting:opacity-0"
      data-criterion-explanation={criterion.id}
    >
      <HarnessMarkdown text={ex.data.text} />
      <p className="text-2xs text-muted-foreground-subtle">
        A reading of the harness's own account by {ex.data.model}
        {ex.data.cached ? ", kept from an earlier ask" : ""} — not part of the record.
      </p>
    </div>
  );
}
