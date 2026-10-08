"use client";

import {
  HISTORY_RETENTION_DAY_OPTIONS,
  HISTORY_RETENTION_DEFAULT_DAYS,
  type HistoryRetentionDays,
} from "@solow/contracts";
import { TASK_RETENTION_DAYS } from "@solow/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebounced } from "@/hooks/use-debounced";
import { trpc } from "@/trpc/react";
import { HistoryRetentionNotice } from "./history-retention-notice";
import { SectionStatus, SettingsField, SettingsLoading, SettingsSection } from "./settings-shell";

/**
 * How long a finished Task keeps its transcript (Decision 0032, FINDINGS F4).
 *
 * The one destructive setting that does its damage later, out of sight — so the section is built
 * around saying *what* it removes before anything is saved. The picker holds a draft; the
 * preview beneath it is the server counting, for that draft, what the hourly sweep would remove
 * if it ran now; and nothing is written until Save. A save-on-change picker, like New task
 * defaults, would have made "what would 7 days do?" a question you could only answer by doing it.
 *
 * `FOREVER` rather than an empty string for the same reason `task-defaults-section.tsx` uses a
 * sentinel: Radix's Select reserves `""` for "nothing selected".
 */

const FOREVER = "forever";

function label(days: number): string {
  return days === 365 ? "1 year" : `${days} days`;
}

function toValue(days: number | null): string {
  return days === null ? FOREVER : String(days);
}

/** "Forever", or a picker value that is not an offered window (which nothing renders), is null. */
function fromValue(value: string): HistoryRetentionDays | null {
  return HISTORY_RETENTION_DAY_OPTIONS.find((days) => String(days) === value) ?? null;
}

const count = new Intl.NumberFormat();

/**
 * How long the picker has to rest before the server is asked to count. The count is cheap but
 * synchronous on the server, and someone stepping through the windows wants the last one counted,
 * not each one they passed.
 */
const PREVIEW_DEBOUNCE_MS = 300;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${count.format(n)} ${n === 1 ? one : many}`;

export function HistoryRetentionSection() {
  const utils = trpc.useUtils();
  const retention = trpc.workspace.historyRetention.useQuery();
  const stored = retention.data ? toValue(retention.data.days) : null;
  const [draft, setDraft] = useState<string | null>(null);

  // Seeded once the stored value arrives, then owned by the picker — a background refetch must
  // not move a choice someone is in the middle of considering.
  useEffect(() => {
    if (stored !== null) setDraft((current) => current ?? stored);
  }, [stored]);

  const draftDays = draft === null ? null : fromValue(draft);
  const settledDays = useDebounced(draftDays, PREVIEW_DEBOUNCE_MS);
  const preview = trpc.workspace.previewHistoryRetention.useQuery(
    { days: settledDays ?? HISTORY_RETENTION_DEFAULT_DAYS },
    { enabled: settledDays !== null && settledDays === draftDays },
  );
  // A count for the window before the one now shown must not be read as this one's.
  const counted = settledDays === draftDays ? preview.data : undefined;

  const save = trpc.workspace.setHistoryRetention.useMutation({
    onSuccess: (next) => {
      utils.workspace.historyRetention.setData(undefined, next);
      setDraft(toValue(next.days));
    },
  });

  const data = retention.data;
  // While the upgrade notice is up, saving the window already shown is still an answer to it.
  const dirty = draft !== null && (draft !== stored || data?.notice === true);

  return (
    <SettingsSection
      caption={`How long a finished Task — Done, or deleted — keeps its transcript. The record of what happened stays for as long as the Task does; deleted Tasks still leave History entirely after ${TASK_RETENTION_DAYS} days.`}
      id="history-retention"
      status={
        data ? (
          <SectionStatus tone={data.days === null ? "idle" : "active"}>
            {data.days === null ? "Kept forever" : `Kept ${label(data.days)}`}
          </SectionStatus>
        ) : null
      }
      title="History retention"
    >
      {data === undefined || draft === null ? (
        <SettingsLoading rows={2} />
      ) : (
        <>
          <HistoryRetentionNotice />
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) save.mutate({ days: draftDays });
            }}
          >
            <SettingsField label="Keep transcripts for">
              <Select onValueChange={setDraft} value={draft}>
                <SelectTrigger aria-label="Keep transcripts for" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.options.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {label(days)}
                      {days === data.defaultDays ? " (default)" : ""}
                    </SelectItem>
                  ))}
                  <SelectItem value={FOREVER}>Forever</SelectItem>
                </SelectContent>
              </Select>
            </SettingsField>
            <Button disabled={!dirty} loading={save.isPending} type="submit">
              Save
            </Button>
          </form>

          {/* The cost of the draft, counted by the server — the sentence this section exists for. */}
          <div aria-live="polite" className="text-sm" data-retention-preview>
            {draftDays === null ? (
              <p className="text-muted-foreground">
                Nothing is removed. Every transcript is kept, and the database grows with every run.
              </p>
            ) : counted === undefined ? (
              settledDays === draftDays && preview.error ? (
                <p className="text-destructive" role="alert">
                  Could not count what this would remove: {preview.error.message}
                </p>
              ) : (
                <Skeleton className="h-4 w-80" />
              )
            ) : counted.events === 0 && counted.diffs === 0 ? (
              <p className="text-muted-foreground">
                Nothing has been finished longer than {label(draftDays)} yet — nothing would be
                removed today.
              </p>
            ) : (
              <p>
                {dirty ? "Saving this would remove" : "The next sweep removes"}{" "}
                <strong className="font-medium tabular-nums">
                  {plural(counted.events, "transcript event")}
                </strong>{" "}
                from {plural(counted.sessions, "session")} of{" "}
                {plural(counted.tasks, "finished task")}, and trim{" "}
                {plural(counted.diffs, "captured diff")} to their file lists.
              </p>
            )}
          </div>

          <dl className="grid gap-3 border-t pt-4 text-xs sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="font-medium text-sm">Removed once the window is up</dt>
              <dd className="text-muted-foreground leading-relaxed">
                The conversation: messages, the harness's reasoning, tool calls and their output,
                its plans, permission prompts and questions answered — and the patch text of each
                captured diff.
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="font-medium text-sm">Always kept</dt>
              <dd className="text-muted-foreground leading-relaxed">
                The Task, its sessions and reviews, state changes and Workflow decisions, how each
                run ended, token usage and spend, and each diff's file list — everything History and
                the outcome numbers are built from.
              </dd>
            </div>
          </dl>

          <p className="text-muted-foreground text-xs">
            Applied hourly by the orchestrator. Only Tasks that are finished count: anything
            running, in review, parked or failed keeps its whole transcript.
          </p>

          {save.error && (
            <p className="text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}
