"use client";

import type { TaskEvent } from "@solow/contracts";
import { ShieldQuestion } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** The one wire event this dialog renders — an agent asking for something (issue #58, AC-4). */
export type PermissionRequest = Extract<TaskEvent, { kind: "permission_request" }>;

/**
 * The permission prompt an ACP agent's request raises in the task workspace (issue #58, AC-4).
 *
 * Two rules shape it, and both come from the same place as ACP's capability negotiation: never
 * invent something the other side did not offer, and never let silence read as consent.
 *
 * - **Only the agent's own options are shown**, in the order it listed them. SoloW does
 *   not add an "always allow" the agent never offered, and does not reword the ones it did.
 * - **There is no dismiss.** Closing the dialog would leave the operator believing they had
 *   declined while the run went on waiting. If the agent offered a refusal, refusing is one of
 *   its buttons; if it offered none, the honest thing is that there is nothing to click.
 *
 * The deadline is stated because it is real, and so is what it does: an unanswered request is
 * *refused* after a couple of minutes so an unattended run cannot hang, and an operator deciding
 * whether to walk away deserves to know which way that falls.
 */
export function PermissionRequestDialog({
  request,
  onChoose,
  deadlineLabel = "about two minutes",
}: {
  /** The outstanding request, or null when there is nothing to ask. */
  request: PermissionRequest | null;
  onChoose: (requestId: string, optionId: string) => void;
  deadlineLabel?: string;
}) {
  return (
    <AlertDialog open={request !== null}>
      {request && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldQuestion className="size-4 shrink-0 text-state-review" aria-hidden />
              The agent is asking for permission
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block font-medium text-foreground">{request.title}</span>
              <span className="mt-2 block">
                {request.toolKind ? `Tool: ${request.toolKind}. ` : ""}
                {/*
                  Deliberately says "the unattended policy decides" rather than "it is refused":
                  refusal is the default, but a deployment can set
                  SOLOW_ACP_UNATTENDED_PERMISSION to the permissive posture, and a dialog
                  that promised refusal on such a deployment would be telling the operator
                  something untrue at the exact moment they are deciding whether to walk away.
                */}
                If nobody answers within {deadlineLabel}, this deployment's unattended permission
                policy settles it and the decision is recorded — by default that is a refusal,
                because silence is not consent.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap">
            {request.options.length > 0 ? (
              request.options.map((option) => (
                <Button
                  key={option.optionId}
                  type="button"
                  variant={option.kind.startsWith("allow") ? "default" : "outline"}
                  onClick={() => onChoose(request.requestId, option.optionId)}
                >
                  {option.name}
                </Button>
              ))
            ) : (
              <p className="text-muted-foreground text-sm">
                The agent offered no options to choose from. The run will continue once its own
                timeout passes.
              </p>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

/**
 * The request still waiting on an answer, out of the live event stream.
 *
 * Derived rather than held in state so a reconnect replay lands in the right place: the log
 * replays the request *and* its resolution, and pairing them here means a question already
 * answered — by this operator, by another one, or by the deadline — never reopens.
 *
 * Two details decide whether that pairing is right, and both were once wrong.
 *
 * The walk is **in order**, and a resolution settles only a request that came *before* it. The
 * event stream spans every run of the Task, so a later round can legitimately reuse an id an
 * earlier one already used; matching by id alone made round two's genuinely new question look
 * like round one's answered one, and the operator was never asked at all.
 *
 * The **oldest** open request wins. Two concurrent tool calls raise two questions, and showing
 * the newest would leave the older one unrendered until its own deadline settled it — surfaced
 * to nobody, which is precisely what AC-4 forbids. One slot, first-in-first-out: answering the
 * one on screen brings up the next.
 */
export function pendingPermission(events: readonly TaskEvent[]): PermissionRequest | null {
  const open: PermissionRequest[] = [];
  for (const event of events) {
    if (event.kind === "permission_request") open.push(event);
    else if (event.kind === "permission_resolved") {
      const index = open.findIndex((r) => r.requestId === event.requestId);
      if (index >= 0) open.splice(index, 1);
    }
  }
  return open[0] ?? null;
}
