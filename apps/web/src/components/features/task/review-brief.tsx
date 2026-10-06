"use client";

import type { ReviewCheckDto, ReviewCriterionDto } from "@solow/contracts";
import { CommonErrorCode, ExplainErrorCode } from "@solow/contracts";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  FileCode2,
  FlaskConical,
  ListTodo,
  MapPinOff,
  MessageCircleQuestion,
  OctagonMinus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { HarnessMarkdown } from "./markdown";

/**
 * The Brief tab (review analysis, point 1): the one view that answers "may I sign this".
 *
 * Three things the page held apart are lined up per acceptance criterion — what the Issue asked,
 * what the harness claims it did (its `step_card`, item by item), and what the change and the
 * run offer as evidence: the files the claim names, the tests it names, and whether any test
 * actually ran. Each criterion ends in the reviewer's own tick, kept in their draft, because the
 * harness's "done" is a claim and the tick is the only thing here that is a fact.
 *
 * **Laid out as a list and a page.** It used to be one long column: every criterion's full text,
 * claim and evidence, then every verification with its whole command line, one under another —
 * forty rows to scroll past to find the one that failed. Now the left is an index — each
 * criterion on a line with its tick and its claim, the open items, the verifications with their
 * failures counted — and the right is the one entry picked, at full size. A summary across the
 * top says where the review stands before anything is opened.
 *
 * The verifications are every check the run executed — a `bun test`, a typecheck, a lint — with
 * the verdict read out of its output and *where* it ran. The harness of the Task this was written
 * for ran its suite from a copy in `/tmp` and reported the numbers as the worktree's; a check run
 * elsewhere is flagged, not hidden.
 */

type Entry =
  | { kind: "criterion"; id: string }
  | { kind: "open-items" }
  | { kind: "checks" }
  | { kind: "checklist" };

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
  const [pick, setPick] = useState<Entry | null>(null);

  if (brief.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 gap-4 p-4" aria-hidden>
        <div className="w-72 space-y-2">
          <div className="h-8 animate-pulse rounded-lg border bg-card" />
          <div className="h-8 animate-pulse rounded-lg border bg-card" />
          <div className="h-8 animate-pulse rounded-lg border bg-card" />
        </div>
        <div className="h-48 flex-1 animate-pulse rounded-lg border bg-card" />
      </div>
    );
  }
  if (!brief.data) {
    return <p className="p-4 text-muted-foreground text-xs">The review brief could not be read.</p>;
  }
  const { criteria, checks, unmatched, worktreePath } = brief.data;
  const done = criteria.filter((c) => verified.includes(c.id)).length;
  const claimed = criteria.filter((c) => c.claim?.state === "done").length;
  const unclaimed = criteria.filter((c) => c.claim === null).length;
  const failed = checks.filter((c) => c.passed === false).length;
  const passed = checks.filter((c) => c.passed === true).length;
  const lastTest = [...checks].reverse().find((c) => c.kind === "test") ?? null;

  // The default entry: the first criterion still to verify, so opening the tab is opening the
  // next piece of work. A pick that names a criterion no longer in the brief falls back to it.
  const fallback: Entry =
    criteria.length > 0
      ? {
          kind: "criterion",
          id: (criteria.find((c) => !verified.includes(c.id)) ?? criteria[0])?.id ?? "",
        }
      : openItems.length > 0
        ? { kind: "open-items" }
        : { kind: "checks" };
  const entry =
    pick && (pick.kind !== "criterion" || criteria.some((c) => c.id === pick.id)) ? pick : fallback;
  const at = entry.kind === "criterion" ? criteria.findIndex((c) => c.id === entry.id) : -1;
  const criterion = at >= 0 ? criteria[at] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-review-brief>
      {/* Where the review stands, before anything is opened. */}
      <dl className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-2.5 text-xs">
        <Stat label="Verified by you">
          <span
            className={cn(done === criteria.length && criteria.length > 0 && "text-feedback-ok")}
          >
            {done}/{criteria.length}
          </span>
        </Stat>
        <Stat label="Claimed done">
          {claimed}/{criteria.length}
        </Stat>
        {unclaimed > 0 ? (
          <Stat label="No claim">
            <span className="text-feedback-caution">{unclaimed}</span>
          </Stat>
        ) : null}
        <Stat label="Checks">
          {checks.length === 0 ? (
            <span className="text-feedback-caution">none ran</span>
          ) : (
            <>
              {failed > 0 ? <span className="text-feedback-error">{failed} failed</span> : null}
              {failed > 0 && passed > 0 ? " · " : null}
              {passed > 0 ? <span className="text-feedback-ok">{passed} passed</span> : null}
              {failed + passed < checks.length ? (
                <span className="text-muted-foreground">
                  {failed + passed > 0 ? " · " : ""}
                  {checks.length - failed - passed} no verdict
                </span>
              ) : null}
            </>
          )}
        </Stat>
        {openItems.length > 0 ? (
          <Stat label="Open items">
            <span className="text-feedback-caution">{openItems.length}</span>
          </Stat>
        ) : null}
        {worktreePath ? (
          <p
            className="ml-auto truncate font-mono text-2xs text-muted-foreground"
            title={worktreePath}
          >
            {worktreePath.slice(worktreePath.lastIndexOf("/") + 1)}
          </p>
        ) : null}
      </dl>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* The index. */}
        <nav
          aria-label="Brief"
          className="max-h-[40%] shrink-0 overflow-y-auto border-b py-2 md:max-h-none md:w-[clamp(260px,32%,400px)] md:border-r md:border-b-0"
        >
          {openItems.length > 0 ? (
            <IndexButton
              current={entry.kind === "open-items"}
              onClick={() => setPick({ kind: "open-items" })}
              icon={<CircleDashed aria-hidden className="size-3.5 text-feedback-caution" />}
              label="Open items"
              count={openItems.length}
              tone="caution"
            />
          ) : null}

          <section aria-label="Acceptance criteria">
            <h2 className="flex items-baseline justify-between gap-2 px-4 pt-3 pb-1.5 font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
              Acceptance criteria
              <span className="font-normal normal-case tracking-normal">
                {criteria.length === 0 ? "none" : `${done} of ${criteria.length} verified by you`}
              </span>
            </h2>
            {criteria.length === 0 ? (
              <p className="px-4 py-1 text-2xs text-muted-foreground">
                No `- [ ] **AC-n**` lines in the issue, so there is nothing to line the claims up
                against.
              </p>
            ) : (
              <ol>
                {criteria.map((c) => (
                  <CriterionIndexRow
                    key={c.id}
                    criterion={c}
                    current={entry.kind === "criterion" && entry.id === c.id}
                    verified={verified.includes(c.id)}
                    canVerify={canVerify}
                    onToggle={() => onToggleVerified(c.id)}
                    onOpen={() => setPick({ kind: "criterion", id: c.id })}
                  />
                ))}
              </ol>
            )}
          </section>

          <div className="mt-2 border-t pt-2">
            <IndexButton
              current={entry.kind === "checks"}
              onClick={() => setPick({ kind: "checks" })}
              icon={<ShieldCheck aria-hidden className="size-3.5 text-muted-foreground" />}
              label="Verifications"
              count={checks.length}
              {...(failed > 0 ? { note: `${failed} failed`, tone: "error" as const } : {})}
            />
            {unmatched.length > 0 ? (
              <IndexButton
                current={entry.kind === "checklist"}
                onClick={() => setPick({ kind: "checklist" })}
                icon={<ListTodo aria-hidden className="size-3.5 text-muted-foreground" />}
                label="The harness's own items"
                count={unmatched.length}
              />
            ) : null}
          </div>
        </nav>

        {/* The entry picked, at full size. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl p-6">
            {criterion ? (
              <CriterionDetail
                // Keyed, so an explanation asked for one criterion is never shown under the next.
                key={criterion.id}
                sessionId={sessionId}
                criterion={criterion}
                lastTest={lastTest}
                verified={verified.includes(criterion.id)}
                onToggle={() => onToggleVerified(criterion.id)}
                canVerify={canVerify}
                position={{ at: at + 1, of: criteria.length }}
                onStep={(by) => {
                  const next = criteria[at + by];
                  if (next) setPick({ kind: "criterion", id: next.id });
                }}
              />
            ) : entry.kind === "open-items" ? (
              <section aria-label="Open items" className="space-y-3">
                <DetailTitle>What the harness left undone</DetailTitle>
                <ul className="space-y-2">
                  {openItems.map((item) => (
                    <li
                      key={item.label}
                      className="rounded-lg border border-feedback-caution/40 bg-feedback-caution/[0.06] px-4 py-3 text-sm"
                    >
                      <p className="font-medium">{item.label}</p>
                      {item.why ? (
                        <p className="mt-1 text-muted-foreground leading-relaxed">{item.why}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : entry.kind === "checklist" ? (
              <section aria-label="Harness checklist" className="space-y-3">
                <DetailTitle>
                  The harness's own items{" "}
                  <span className="font-normal text-muted-foreground text-sm">
                    — no criterion named
                  </span>
                </DetailTitle>
                <ul className="space-y-1.5 text-sm">
                  {unmatched.map((claim) => (
                    <li key={claim.label} className="flex items-start gap-2">
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
            ) : (
              <ChecksDetail checks={checks} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function DetailTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-semibold text-base leading-snug">{children}</h2>;
}

function IndexButton({
  current,
  onClick,
  icon,
  label,
  count,
  note,
  tone,
}: {
  current: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  note?: string;
  tone?: "caution" | "error";
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
        current && "bg-accent font-medium",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note ? (
        <span
          className={cn(
            "text-2xs",
            tone === "error" ? "text-feedback-error" : "text-feedback-caution",
          )}
        >
          {note}
        </span>
      ) : null}
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

/** A criterion on one line of the index: its tick, its id, its text cut short, its claim. */
function CriterionIndexRow({
  criterion,
  current,
  verified,
  canVerify,
  onToggle,
  onOpen,
}: {
  criterion: ReviewCriterionDto;
  current: boolean;
  verified: boolean;
  canVerify: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 px-4 py-1.5 transition-colors hover:bg-accent/50",
        current && "bg-accent",
      )}
      data-criterion={criterion.id}
    >
      <Checkbox
        className="mt-0.5"
        aria-label={`Verified ${criterion.id} myself`}
        checked={verified}
        disabled={!canVerify}
        onCheckedChange={onToggle}
      />
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 text-left text-xs"
      >
        <span className="mt-px shrink-0 rounded bg-muted px-1 font-mono text-2xs">
          {criterion.id}
        </span>
        <span
          className={cn(
            "line-clamp-2 min-w-0 flex-1 leading-snug",
            verified && "text-muted-foreground",
            current && "font-medium",
          )}
        >
          {criterion.text}
        </span>
        {criterion.claim ? (
          <ClaimIcon state={criterion.claim.state} />
        ) : (
          <CircleHelp
            aria-label="no claim"
            className="mt-0.5 size-3.5 shrink-0 text-feedback-caution"
          />
        )}
      </button>
    </li>
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

/** One criterion at full size: what was asked, what was claimed, the evidence, and the tick. */
function CriterionDetail({
  sessionId,
  criterion,
  lastTest,
  verified,
  onToggle,
  canVerify,
  position,
  onStep,
}: {
  sessionId: string;
  criterion: ReviewCriterionDto;
  lastTest: ReviewCheckDto | null;
  verified: boolean;
  onToggle: () => void;
  canVerify: boolean;
  position: { at: number; of: number };
  onStep: (by: -1 | 1) => void;
}) {
  const claim = criterion.claim;
  const ex = useExplainCriterion(sessionId, criterion);
  const tickId = useId();
  // "NOT executed here" inside a note is what the evidence block exists to make visible.
  const notExecuted = /not (executed|run)|unexecuted/i.test(claim?.note ?? "");
  return (
    <article aria-label={criterion.id} className="space-y-5" data-criterion-detail={criterion.id}>
      <header className="flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{criterion.id}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {position.at} of {position.of}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ExplainButton ex={ex} criterion={criterion} />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous criterion"
            disabled={position.at <= 1}
            onClick={() => onStep(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next criterion"
            disabled={position.at >= position.of}
            onClick={() => onStep(1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </header>

      <p className="text-base leading-relaxed">{criterion.text}</p>

      <ExplanationBlock ex={ex} criterion={criterion} />

      <section aria-label="The harness's claim" className="space-y-1.5">
        <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
          The harness's claim
        </h3>
        {claim ? (
          <p className="flex items-start gap-2 text-sm">
            <ClaimIcon state={claim.state} />
            <span className="min-w-0">
              <span className="font-medium">{CLAIM_STYLE[claim.state].label}</span>
              {claim.note ? <span className="text-muted-foreground"> — {claim.note}</span> : null}
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-2 font-medium text-feedback-caution text-sm">
            <CircleHelp aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            The harness made no claim about this criterion.
          </p>
        )}
      </section>

      {criterion.files.length > 0 || criterion.tests.length > 0 ? (
        <section aria-label="Evidence" className="space-y-2">
          <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
            Evidence
          </h3>
          {criterion.files.length > 0 ? (
            <ul className="space-y-1">
              {criterion.files.map((path) => (
                <li key={path} className="flex items-center gap-2 font-mono text-xs">
                  <FileCode2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-all">{path}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {criterion.tests.length > 0 ? (
            <p className="flex items-start gap-2 text-sm">
              <FlaskConical
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
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
        </section>
      ) : null}

      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border px-4 py-3",
          verified ? "border-feedback-ok/40 bg-feedback-ok/[0.06]" : "bg-card",
        )}
      >
        <Checkbox
          id={tickId}
          aria-describedby={`${tickId}-hint`}
          checked={verified}
          disabled={!canVerify}
          onCheckedChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={tickId} className="text-sm">
            I verified this myself
          </label>
          <p id={`${tickId}-hint`} className="text-muted-foreground text-xs">
            {canVerify
              ? "Your tick is kept in your review draft — the harness's claim is not a verification."
              : "Ticks are only taken at the gate, on the round it is about."}
          </p>
        </div>
        {position.at < position.of ? (
          <Button size="sm" variant="outline" onClick={() => onStep(1)}>
            Next
            <ChevronRight />
          </Button>
        ) : null}
      </div>
    </article>
  );
}

const CHECK_LABEL: Record<ReviewCheckDto["kind"], string> = {
  test: "tests",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
  audit: "audit",
};

/** Every check the run executed: failures first when asked, each with where it ran and when. */
function ChecksDetail({ checks }: { checks: readonly ReviewCheckDto[] }) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const failed = checks.filter((c) => c.passed === false).length;
  const shown = failuresOnly ? checks.filter((c) => c.passed === false) : checks;
  return (
    <section aria-label="Verifications" className="space-y-3">
      <div className="flex items-center gap-3">
        <DetailTitle>Verifications the run executed</DetailTitle>
        {failed > 0 ? (
          <Button
            size="xs"
            variant={failuresOnly ? "secondary" : "ghost"}
            aria-pressed={failuresOnly}
            className="ml-auto"
            onClick={() => setFailuresOnly((was) => !was)}
          >
            Failures only
          </Button>
        ) : null}
      </div>
      {checks.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-3 text-feedback-caution text-sm">
          No test, lint or typecheck was run. Whatever the summary says, nothing here was verified.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {shown.map((check, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a check is positional in the log; the list is never reordered
            <CheckRow key={index} check={check} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckRow({ check }: { check: ReviewCheckDto }) {
  const Verdict = check.passed === true ? Check : check.passed === false ? X : CircleHelp;
  return (
    <li className="space-y-1 px-4 py-2.5 text-sm" data-check={check.kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="w-20 shrink-0 font-medium">{CHECK_LABEL[check.kind]}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono text-xs",
            check.passed === true && "text-feedback-ok",
            check.passed === false && "text-feedback-error",
            check.passed === null && "text-muted-foreground",
          )}
        >
          <Verdict aria-hidden className="size-3.5" />
          {check.verdict}
        </span>
        {check.elsewhere ? (
          <span className="inline-flex items-center gap-1 text-feedback-caution text-xs">
            <MapPinOff aria-hidden className="size-3" />
            ran in {check.cwd} — not this worktree
          </span>
        ) : null}
        {check.passed === null && check.verdict === "no result" ? (
          <span className="inline-flex items-center gap-1 text-feedback-caution text-xs">
            <TriangleAlert aria-hidden className="size-3" /> no result came back
          </span>
        ) : null}
        <span className="ml-auto text-muted-foreground text-xs">{relativeAge(check.at)}</span>
      </div>
      <details className="group">
        <summary className="cursor-pointer list-none truncate font-mono text-2xs text-muted-foreground group-open:whitespace-normal group-open:break-all hover:text-foreground">
          {check.command}
        </summary>
      </details>
    </li>
  );
}

/** What the ask can say when it fails, in words — the code is never shown. */
const EXPLAIN_MESSAGE: Record<string, string> = {
  [ExplainErrorCode.NoCredential]:
    "This task's harness profile has no usable credential — check the Secret it points at.",
  [ExplainErrorCode.Upstream]: "The task's harness could not answer. Try again in a moment.",
  [CommonErrorCode.RateLimited]: "Rate limited — try again in a moment.",
};

/**
 * "Explain" on a criterion: a plain-language reading of it, for someone who does not read
 * code, anchored in the harness's own account of the run (see dal/explain-criterion.ts).
 *
 * Asked on the press, never on render — it is billed — and asked once: the answer is held here
 * for the life of the panel and on the server for a day, so the button then only folds the
 * text away and back. Written in the reader's language (`navigator.language`); the criterion's
 * identifiers stay as they are.
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
      className="shrink-0 text-muted-foreground hover:text-foreground"
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
      <p className="flex items-center gap-2 text-feedback-error text-xs" role="alert">
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
      className="space-y-2 rounded-lg bg-muted/40 px-4 py-3 text-sm leading-relaxed transition-opacity duration-150 starting:opacity-0"
      data-criterion-explanation={criterion.id}
    >
      <HarnessMarkdown text={ex.data.text} />
      <p className="text-2xs text-muted-foreground-subtle">
        A reading of its own account by the task's harness
        {ex.data.model ? ` (${ex.data.model})` : ""}
        {ex.data.cached ? ", kept from an earlier ask" : ""} — not part of the record.
      </p>
    </div>
  );
}
