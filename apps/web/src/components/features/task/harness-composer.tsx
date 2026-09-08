"use client";

import { CornerDownLeft, Square } from "lucide-react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Steering a live harness (TASK-022): the message box under the terminal, and the stop beside it.
 *
 * A surface of its own rather than a bare input on the page. This is the one control here that
 * *does* something to a running harness, and it read as a search box below the transcript — so it
 * is framed, its field is borderless inside that frame (two nested outlines around one field is
 * the look the framing replaces), and its actions are grouped hard right. That right edge is the
 * same one the operator's own turns now sit on in the transcript above: the whole right side of
 * this panel is "what you say", the left is "what the harness says".
 *
 * Extracted from the workspace so it can be rendered — and looked at — on its own.
 */
export function HarnessComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  canSteer,
  isRunning,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** False when there is no live harness to reach — the whole row goes quiet rather than lying. */
  canSteer: boolean;
  isRunning: boolean;
}) {
  return (
    <form
      // Wraps rather than crushes. Send and Stop have a fixed appetite, so on a narrow run column
      // a single row spent the remainder on the field and left a box two characters wide; below
      // the field's floor the actions drop to their own line instead, which is the arrangement
      // that still lets someone type.
      className="surface-edge flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-card/60 p-2 transition-colors focus-within:border-ring/40"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="harness-input">
        Message the harness
      </label>
      <Input
        id="harness-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!canSteer}
        placeholder={
          isRunning
            ? "Message the harness…"
            : "The harness is not running, so there is nothing to steer."
        }
        // A floor, not a fixed width: without one the field's flex basis is its placeholder and it
        // pushed Send and Stop out of the form; with one it holds 10rem and the actions wrap.
        className="h-9 min-w-40 flex-1 border-0 bg-transparent text-sm shadow-none focus-visible:border-0"
      />
      <Button type="submit" disabled={!canSteer || !value.trim()}>
        <CornerDownLeft /> Send
      </Button>
      <ConfirmAction
        disabled={!canSteer}
        title="Stop the harness?"
        description="The harness stops where it is. Whatever it has already changed stays in the worktree and goes to review. Nothing is discarded."
        confirmLabel="Stop the harness"
        onConfirm={onStop}
        trigger={
          <Button type="button" variant="outline" disabled={!canSteer}>
            <Square /> Stop
          </Button>
        }
      />
    </form>
  );
}
