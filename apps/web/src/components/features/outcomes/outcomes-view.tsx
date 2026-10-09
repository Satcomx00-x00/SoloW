"use client";

import {
  CommonErrorCode,
  OUTCOMES_WINDOW_WEEKS,
  type OutcomesDto,
  type OutcomesSpendDto,
} from "@solow/contracts";
import { ChartNoAxesColumn, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { FlagDisabled } from "@/components/features/shared/flag-disabled";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { STATE_LABELS } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * Outcomes (finding A4): whether the loop works, from what SoloW already records.
 *
 * Every number sits next to the sentence that defines it, because each one is a choice (what
 * "shipped" means, what an "attempt" is) and a figure the reader has to guess the meaning of is
 * not evidence. The definitions are the contract's (`outcomesDto`), restated in plain words.
 *
 * Colour follows the design system: chroma-zero, except the shipped bars, which use Done Green
 * because they count Tasks that reached Done.
 */
export function OutcomesView() {
  const [weeks, setWeeks] = useState<number>(12);
  const outcomes = trpc.outcomes.get.useQuery({ weeks });

  if (outcomes.error) {
    return (
      <Frame>
        {outcomes.error.message === CommonErrorCode.FlagDisabled ? (
          <FlagDisabled flag="ff-outcomes" title="Outcomes are not enabled here" />
        ) : (
          <div className="flex items-start gap-2.5 text-sm">
            <TriangleAlert className="mt-px size-4 shrink-0 text-state-failed" aria-hidden />
            <div role="alert">
              <p className="font-medium">Failed to load outcomes</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {describeError(outcomes.error)}
              </p>
            </div>
          </div>
        )}
      </Frame>
    );
  }

  const data = outcomes.data;
  return (
    <Frame>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 font-semibold text-lg">
            <ChartNoAxesColumn aria-hidden className="size-4 text-muted-foreground" />
            Outcomes
          </h1>
          <p className="max-w-xl text-muted-foreground text-sm">
            What the loop delivered, counted from what SoloW already records. Deleted tasks are left
            out. Weeks start on Monday, in UTC.
          </p>
        </div>
        <WindowPicker weeks={weeks} onChange={setWeeks} />
      </header>

      {outcomes.isLoading || !data ? (
        <div className="space-y-3" aria-hidden>
          <div className="h-40 animate-pulse rounded-xl border bg-card" />
          <div className="h-28 animate-pulse rounded-xl border bg-card" />
        </div>
      ) : isEmpty(data) ? (
        <div className="surface-edge flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border bg-card px-6 text-center">
          <p className="font-medium text-sm">Nothing to measure in the last {weeks} weeks</p>
          <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
            Figures appear once a task has run here. Approve one and it counts as shipped.
          </p>
          <FirstPullRequest data={data} />
        </div>
      ) : (
        <>
          <Shipped data={data} />
          <Approval data={data} />
          <Spend data={data} />
          <section className="surface-edge rounded-xl border bg-card px-5 py-4">
            <FirstPullRequest data={data} />
          </section>
        </>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8 sm:px-6">{children}</div>;
}

function isEmpty(data: OutcomesDto): boolean {
  return (
    data.shipped.total === 0 &&
    data.shipped.approvedNotDelivered === 0 &&
    data.approval.runTasks === 0 &&
    data.spend.total.turns === 0
  );
}

function WindowPicker({ weeks, onChange }: { weeks: number; onChange: (weeks: number) => void }) {
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">Window</legend>
      {OUTCOMES_WINDOW_WEEKS.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={option === weeks ? "secondary" : "ghost"}
          aria-pressed={option === weeks}
          onClick={() => onChange(option)}
        >
          {option} weeks
        </Button>
      ))}
    </fieldset>
  );
}

/** A section with its heading and the sentence that defines what it counts. */
function Section({
  title,
  definition,
  children,
}: {
  title: string;
  definition: ReactNode;
  children: ReactNode;
}) {
  const id = `outcomes-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="surface-edge space-y-4 rounded-xl border bg-card p-5">
      <div className="space-y-1">
        <h2 id={id} className="font-semibold text-sm">
          {title}
        </h2>
        <p className="max-w-2xl text-muted-foreground text-xs leading-relaxed">{definition}</p>
      </div>
      {children}
    </section>
  );
}

function Figure({ value, label, focal }: { value: string; label: string; focal?: boolean }) {
  return (
    // The term comes first in the markup, as a description list requires; `order` puts the number
    // on top, where the eye lands.
    <div className="flex min-w-0 flex-col">
      <dt className="order-2 text-muted-foreground text-xs">{label}</dt>
      <dd className={cn("order-1 font-semibold tabular-nums", focal ? "text-2xl" : "text-lg")}>
        {value}
      </dd>
    </div>
  );
}

const WEEK_LABEL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const weekLabel = (weekStart: string) => WEEK_LABEL.format(new Date(`${weekStart}T00:00:00Z`));

function Shipped({ data }: { data: OutcomesDto }) {
  const { shipped } = data;
  const peak = Math.max(1, ...shipped.weeks.map((w) => w.shipped));
  const perWeek = shipped.total / data.window.weeks;
  return (
    <Section
      title="Shipped"
      definition="A task is shipped when it is Done, a person approved it, and the approval was committed. It counts once, in the week of its latest approval. A pull request on any of its repositories makes it a pull request; otherwise it is a local commit (no remote, or Keep local). A task dragged to Done without an approval does not count."
    >
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <Figure focal value={formatCount(shipped.total)} label="shipped" />
        <Figure value={formatCount(shipped.asPullRequest)} label="as pull request" />
        <Figure value={formatCount(shipped.localCommit)} label="as local commit" />
        <Figure value={perWeek.toFixed(1)} label="per week, on average" />
      </dl>
      <ol aria-label="Shipped per week" className="flex h-32 items-end gap-1 overflow-x-auto pb-5">
        {shipped.weeks.map((week) => {
          const local = week.shipped - week.asPullRequest;
          return (
            <li
              key={week.weekStart}
              className="relative flex h-full min-w-3 flex-1 flex-col justify-end"
              title={`Week of ${weekLabel(week.weekStart)}: ${week.shipped} shipped`}
            >
              <span className="sr-only">
                Week of {weekLabel(week.weekStart)}: {week.shipped} shipped, {week.asPullRequest} as
                pull request.
              </span>
              <span
                aria-hidden
                className="rounded-t-sm bg-state-done/40"
                style={{ height: `${(local / peak) * 100}%` }}
              />
              <span
                aria-hidden
                className={cn("bg-state-done", local === 0 && "rounded-t-sm")}
                style={{ height: `${(week.asPullRequest / peak) * 100}%` }}
              />
              <span aria-hidden className="h-px bg-border" />
              <span
                aria-hidden
                className="absolute top-full mt-1 w-full truncate text-center text-2xs text-muted-foreground tabular-nums"
              >
                {shipped.weeks.length <= 12 ? weekLabel(week.weekStart) : ""}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-state-done" /> pull request
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-state-done/40" /> local commit
        </span>
        <span>Tallest bar: {peak}</span>
      </p>
      {shipped.approvedNotDelivered > 0 ? (
        <p className="text-xs">
          {shipped.approvedNotDelivered} approved in this window{" "}
          {shipped.approvedNotDelivered === 1 ? "was" : "were"} committed but not delivered: the
          push or the pull request failed. They count once Ship again or Keep local finishes them.
        </p>
      ) : null}
    </Section>
  );
}

function Approval({ data }: { data: OutcomesDto }) {
  const { approval } = data;
  const peak = Math.max(1, ...approval.attempts.map((a) => a.tasks));
  return (
    <Section
      title="Reaching approval"
      definition={
        <>
          Counted over the {approval.runTasks} task{approval.runTasks === 1 ? "" : "s"} first run in
          this window. An attempt is one round judged at the review gate: each reject or request for
          changes before the approval adds one, across every workflow step. A run that failed and
          was retried before reaching the gate is not an attempt.
          {approval.inFlight > 0
            ? ` ${approval.inFlight} still running, parked or waiting for review ${approval.inFlight === 1 ? "is" : "are"} left out of both rates until ${approval.inFlight === 1 ? "it settles" : "they settle"}.`
            : ""}
        </>
      }
    >
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <Figure
          focal
          value={formatShare(approval.withinTwoRate)}
          label={`approved within two attempts (${approval.approvedWithinTwo} of ${approval.settled})`}
        />
        <Figure
          value={formatShare(approval.approvalRate)}
          label={`run-to-approval rate (${approval.approved} of ${approval.settled})`}
        />
        <Figure
          value={approval.meanAttempts === null ? "None yet" : approval.meanAttempts.toFixed(1)}
          label="attempts per approved task"
        />
      </dl>
      <table className="w-full max-w-md text-xs">
        <caption className="sr-only">Approved tasks by attempts</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Attempts</th>
            <th scope="col">Share</th>
            <th scope="col">Tasks</th>
          </tr>
        </thead>
        <tbody>
          {approval.attempts.map((bucket) => (
            <tr key={bucket.attempts}>
              <th
                scope="row"
                className="w-32 whitespace-nowrap py-1 pr-3 text-left font-normal text-muted-foreground"
              >
                {bucket.attempts}
                {bucket.orMore ? " or more" : ""}{" "}
                {bucket.attempts === 1 && !bucket.orMore ? "attempt" : "attempts"}
              </th>
              <td className="py-1">
                <span
                  aria-hidden
                  className="block h-2 rounded-sm bg-muted-foreground/50"
                  style={{ width: `${(bucket.tasks / peak) * 100}%` }}
                />
              </td>
              <td className="w-10 py-1 pl-3 text-right tabular-nums">{bucket.tasks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Spend({ data }: { data: OutcomesDto }) {
  const { spend } = data;
  const perTask = spend.tasks > 0 ? tokens(spend.total) / spend.tasks : null;
  return (
    <Section
      title="Spend"
      definition="Tokens from every turn recorded in this window, by the harness profile it ran under. Cost is metered cost only: API-key turns priced from SoloW's price table. Subscription turns have no per-token charge, and a model missing from the price table is counted as unpriced rather than free. Billing mode is each profile's current mode."
    >
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        {/* Both totals, because cache reads usually dwarf the rest and are billed at a fraction
            of an input token: the all-in figure alone would read as far more work than it is. */}
        <Figure focal value={formatTokens(tokens(spend.total))} label="tokens, cache included" />
        <Figure
          value={formatTokens(spend.total.inputTokens + spend.total.outputTokens)}
          label="input and output only"
        />
        <Figure
          value={perTask === null ? "None yet" : formatTokens(perTask)}
          label={`tokens per task (${spend.tasks} task${spend.tasks === 1 ? "" : "s"})`}
        />
        {spend.total.meteredTurns === 0 ? (
          // "$0.00" would read as free; nothing was billed per token, which is a different fact.
          <Figure value="None" label="metered cost: no API-key turns" />
        ) : (
          <Figure value={formatUsd(spend.total.meteredCostUsd)} label="metered cost" />
        )}
      </dl>
      <Gaps spend={spend.total} />
      <SpendTable
        caption="By billing mode"
        rows={spend.byBillingMode.map((m) => ({
          key: m.authMode,
          name: m.authMode === "api_key" ? "API key" : "Subscription",
          spend: m,
          authMode: m.authMode,
        }))}
      />
      <SpendTable
        caption="By harness profile"
        rows={spend.byProfile.map((p) => ({
          key: p.profileId,
          name: p.name,
          detail: `${p.tasks} task${p.tasks === 1 ? "" : "s"}`,
          spend: p,
          authMode: p.authMode,
        }))}
      />
      <SpendTable
        caption="Tasks that used the most"
        rows={spend.topTasks.map((t) => ({
          key: t.taskId,
          name: (
            <Link href={`/task/${t.taskId}`} className="hover:underline">
              {t.title}
            </Link>
          ),
          detail: STATE_LABELS[t.state],
          spend: t,
          authMode: t.meteredTurns > 0 ? "api_key" : "subscription",
        }))}
      />
    </Section>
  );
}

function Gaps({ spend }: { spend: OutcomesSpendDto }) {
  if (spend.unreportedTurns === 0 && spend.unpricedTurns === 0) return null;
  return (
    <p className="text-xs">
      {spend.unreportedTurns > 0
        ? `${spend.unreportedTurns} turn${spend.unreportedTurns === 1 ? "" : "s"} reported no usage, so the token total is a lower bound. `
        : ""}
      {spend.unpricedTurns > 0
        ? `${spend.unpricedTurns} API-key turn${spend.unpricedTurns === 1 ? "" : "s"} used a model the price table does not know, so the metered cost is a lower bound.`
        : ""}
    </p>
  );
}

interface SpendRow {
  key: string;
  name: ReactNode;
  detail?: string;
  spend: OutcomesSpendDto;
  authMode: "subscription" | "api_key";
}

function SpendTable({ caption, rows }: { caption: string; rows: SpendRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      {/* Fixed layout and one set of widths, so the three tables' columns line up as one grid. */}
      <table className="w-full min-w-[34rem] table-fixed text-xs">
        <colgroup>
          <col className="w-[34%]" />
          <col />
          <col />
          <col />
          <col />
          <col className="w-[18%]" />
        </colgroup>
        <caption className="pb-1.5 text-left font-medium text-foreground/80">{caption}</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 text-left font-normal">
              Name
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-normal">
              Turns
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-normal">
              Input
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-normal">
              Output
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-normal">
              Cache
            </th>
            <th scope="col" className="py-1.5 pl-3 text-right font-normal">
              Metered cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-0">
              <th scope="row" className="max-w-56 py-1.5 pr-3 text-left font-normal">
                <span className="block truncate">{row.name}</span>
                {row.detail ? (
                  <span className="block text-2xs text-muted-foreground">{row.detail}</span>
                ) : null}
              </th>
              <td className="px-3 py-1.5 text-right tabular-nums">{row.spend.turns}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatTokens(row.spend.inputTokens)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatTokens(row.spend.outputTokens)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatTokens(row.spend.cacheReadTokens + row.spend.cacheWriteTokens)}
              </td>
              <td className="py-1.5 pl-3 text-right tabular-nums">
                <Cost spend={row.spend} authMode={row.authMode} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cost({
  spend,
  authMode,
}: {
  spend: OutcomesSpendDto;
  authMode: "subscription" | "api_key";
}) {
  if (spend.meteredTurns === 0) {
    return (
      <span className="text-muted-foreground">
        {authMode === "subscription" ? "Subscription" : "None"}
      </span>
    );
  }
  return (
    <>
      {formatUsd(spend.meteredCostUsd)}
      {spend.unpricedTurns > 0 ? (
        <span className="block text-2xs text-muted-foreground">
          +{spend.unpricedTurns} unpriced
        </span>
      ) : null}
    </>
  );
}

function FirstPullRequest({ data }: { data: OutcomesDto }) {
  const { firstPullRequest } = data;
  if (firstPullRequest.elapsedMs === null) {
    return (
      <p className="text-muted-foreground text-xs">
        No task has shipped as a pull request yet, so there is no time to first pull request.
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-semibold tabular-nums">
        {formatDuration(firstPullRequest.elapsedMs)}
      </span>{" "}
      <span className="text-muted-foreground">
        from this workspace's creation to its first task shipped as a pull request (dated by that
        task's latest approval).
      </span>
    </p>
  );
}

function tokens(spend: OutcomesSpendDto): number {
  return spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheWriteTokens;
}

const COUNT = new Intl.NumberFormat();
const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatTokens(value: number): string {
  return value < 10_000 ? COUNT.format(Math.round(value)) : COMPACT.format(value);
}

export function formatShare(value: number | null): string {
  return value === null ? "None yet" : `${Math.round(value * 100)}%`;
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "< $0.01";
  return USD.format(value);
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours / 24)} days`;
}
