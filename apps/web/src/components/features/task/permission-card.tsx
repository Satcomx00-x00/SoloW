"use client";

import { ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PermissionRow } from "./transcript";

/**
 * A permission question, asked and answered *inside* the transcript.
 *
 * `PermissionRequestDialog` asks the same question in a modal, and the modal traps focus — which
 * is the whole reason this exists. The thing an operator needs in order to answer "may I write
 * .env" is the tool call, the file and the turn that led to it, and all three are in the rows
 * directly above this one; a dialog puts a scrim over the evidence and asks for a decision
 * anyway. Inline, the question sits where the run reached it and the transcript stays readable.
 *
 * What is *not* reinvented here is the wording and the two rules behind it, both lifted from the
 * dialog: only the agent's own options are offered, in the order it listed them — GateControl
 * never invents an "always allow" — and there is no dismiss, because a card that could be waved
 * away would leave an operator believing they had declined while the run went on waiting.
 *
 * The card renders in two states and the row decides which: `resolution === null` is a live
 * question, anything else is a record of one. A settled question never shows a button again,
 * which is what lets someone read a finished run and still see what was asked and what was
 * answered without being able to answer it a second time.
 */
export function PermissionCard({
  row,
  onRespond,
}: {
  row: PermissionRow;
  onRespond: (optionId: string) => void;
}) {
  if (row.resolution) return <SettledCard row={row} resolution={row.resolution} />;

  return (
    // A `fieldset` because that is what this is — a set of controls asked one question — and it
    // carries `role="group"` without being told to. The label repeats the question so a screen
    // reader reaching the buttons is told what they answer; "Allow once" alone says nothing.
    // Deliberately *not* an aria-live region and deliberately not focused on mount: a live
    // region has to exist before the mutation to announce it, so one arriving with the card
    // announces nothing anyway, and stealing focus from an operator mid-sentence is the
    // interruption the modal was replaced to stop. The transcript container owns the
    // announcement; this owns being findable once you look.
    <fieldset
      aria-label={`Permission request: ${row.title}`}
      data-permission={row.requestId}
      data-resolution="open"
      // Loud on purpose. This is the one row in a scrolling transcript that is waiting on a
      // human, and --state-review is the colour the board already uses for "needs you".
      // `min-w-0` because a fieldset defaults to min-content width and a long unbroken path in
      // the title would otherwise push the whole transcript sideways.
      className="surface-edge min-w-0 space-y-2.5 rounded-xl border border-state-review/40 bg-state-review/[0.06] p-3.5"
    >
      <p className="flex items-center gap-2 font-medium text-sm">
        <ShieldQuestion className="size-4 shrink-0 text-state-review" aria-hidden />
        The agent is asking for permission
      </p>

      <div className="space-y-1">
        <p className="font-medium text-foreground text-sm">{row.title}</p>
        {row.toolKind && (
          <p className="font-mono text-2xs text-muted-foreground uppercase tracking-wider">
            {row.toolKind}
          </p>
        )}
      </div>

      {/*
        Says "the policy settles it" rather than "it is refused", for the same reason the dialog
        does: refusal is the default, but the posture is a deployment setting, and promising a
        refusal on a deployment configured the other way would be a lie told at the exact moment
        someone is deciding whether to walk away. No duration is quoted here — the deadline is
        the server's, the dialog already carries the operator-facing copy of it, and a second
        hardcoded number in a second component is the kind of thing that goes stale silently.
      */}
      <p className="text-muted-foreground text-xs leading-relaxed">
        If nobody answers, this deployment's unattended permission policy settles it and the
        decision is recorded — by default that is a refusal, because silence is not consent.
      </p>

      {row.options.length > 0 ? (
        // Plain buttons in the agent's own order: the first option an agent lists is the one it
        // considers the ordinary answer, and reordering them would be GateControl editing the
        // question. DOM order is the tab order, so that ordering is what keyboard users get.
        <div className="flex flex-wrap gap-2 pt-0.5">
          {row.options.map((option) => (
            <Button
              key={option.optionId}
              type="button"
              size="sm"
              variant={option.kind.startsWith("allow") ? "default" : "outline"}
              onClick={() => onRespond(option.optionId)}
            >
              {option.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          The agent offered no options to choose from. The run will continue once its own timeout
          passes.
        </p>
      )}
    </fieldset>
  );
}

/**
 * The same question after it stopped being one.
 *
 * Kept in the transcript rather than collapsed away, because "what did we agree to let this run
 * do" is exactly the question a reviewer asks afterwards, and an answer with no record of what
 * was asked is not an answer. It is drawn quietly — this row no longer wants anyone's attention.
 */
function SettledCard({
  row,
  resolution,
}: {
  row: PermissionRow;
  resolution: NonNullable<PermissionRow["resolution"]>;
}) {
  // Resolve the id back to the agent's own wording where we can. A resolution can name an option
  // this client never saw — the deadline policy answers by id, and a reconnect can land the
  // resolution while the request itself sits in a compacted range — so the raw id is the
  // fallback rather than a blank. A null id is a refusal with nothing chosen at all.
  const chosen = row.options.find((option) => option.optionId === resolution.optionId);
  const answer = chosen?.name ?? resolution.optionId ?? "Declined";
  const allowed = chosen ? chosen.kind.startsWith("allow") : false;
  const Icon = allowed ? ShieldCheck : ShieldX;

  return (
    // No `role="group"` and no label here, unlike the open card: there is nothing left to group
    // — the controls are gone and what remains is a sentence, which a screen reader reads as a
    // sentence. Announcing it as a labelled group would promise an interaction that is over.
    <div
      data-permission={row.requestId}
      data-resolution="settled"
      className="rounded-xl border border-dashed bg-card/40 p-3"
    >
      <p className="flex items-start gap-2 text-sm">
        <Icon
          className={cn(
            "mt-px size-3.5 shrink-0",
            allowed ? "text-state-done" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 break-words text-muted-foreground">
          <span className="text-foreground">{row.title}</span> — {answer},{" "}
          {/*
            Who decided is load-bearing, not decoration: "operator" means a human looked at this
            and said yes, "policy" means nobody did and the deadline answered for them. A review
            that cannot tell those apart is reading consent into silence.
          */}
          {resolution.decidedBy === "operator" ? "chosen by the operator" : "settled by policy"}
        </span>
      </p>
    </div>
  );
}
