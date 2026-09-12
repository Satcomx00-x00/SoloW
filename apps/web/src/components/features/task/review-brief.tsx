"use client";

import type { ReviewCheckDto, ReviewCriterionDto } from "@solow/contracts";
import {
  Check,
  CircleDashed,
  CircleHelp,
  FlaskConical,
  MapPinOff,
  OctagonMinus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

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
  criterion,
  lastTest,
  verified,
  onToggle,
  canVerify,
}: {
  criterion: ReviewCriterionDto;
  lastTest: ReviewCheckDto | null;
  verified: boolean;
  onToggle: () => void;
  canVerify: boolean;
}) {
  const claim = criterion.claim;
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
        <p>
          <span className="mr-1.5 rounded bg-muted px-1 font-mono text-2xs">{criterion.id}</span>
          <span className={cn(verified && "text-muted-foreground")}>{criterion.text}</span>
        </p>
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
