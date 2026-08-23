"use client";

import { CornerDownLeft, Square } from "lucide-react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Steering a live agent (TASK-022): the message box under the terminal, and the stop beside it.
 *
 * A surface of its own rather than a bare input on the page. This is the one control here that
 * *does* something to a running agent, and it read as a search box below the transcript — so it
 * is framed, its field is borderless inside that frame (two nested outlines around one field is
 * the look the framing replaces), and its actions are grouped hard right. That right edge is the
 * same one the operator's own turns now sit on in the transcript above: the whole right side of
 * this panel is "what you say", the left is "what the agent says".
 *
 * Extracted from the workspace so it can be rendered — and looked at — on its own.
 */
export function AgentComposer({
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
  /** False when there is no live agent to reach — the whole row goes quiet rather than lying. */
  canSteer: boolean;
  isRunning: boolean;
}) {
  return (
    <form
      className="surface-edge flex items-center gap-2 rounded-xl border bg-card/60 p-2 transition-colors focus-within:border-ring/40"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="agent-input">
        Message the agent
      </label>
      <Input
        id="agent-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!canSteer}
        placeholder={
          isRunning
            ? "Message the agent…"
            : "The agent is not running, so there is nothing to steer."
        }
        className="h-9 flex-1 border-0 bg-transparent text-sm shadow-none focus-visible:border-0"
      />
      <Button type="submit" disabled={!canSteer || !value.trim()}>
        <CornerDownLeft /> Send
      </Button>
      <ConfirmAction
        disabled={!canSteer}
        title="Stop the agent?"
        description="The agent stops where it is. Whatever it has already changed stays in the worktree and goes to review. Nothing is discarded."
        confirmLabel="Stop the agent"
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
