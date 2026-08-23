"use client";

import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentActivity } from "./transcript";

/**
 * What the agent is doing while it is not producing text.
 *
 * A run is mostly silence. Launching takes seconds before the first token, a `Bash` call can take
 * a minute, and a thinking block streams nothing anyone was meant to read — and through all of it
 * the panel showed a settled transcript, which looks exactly like a run that has hung. The
 * operator's only recourse was to watch the auto-scroll dot and guess.
 *
 * So the foot of the transcript always answers the question. `agentActivity` decides *what* is
 * happening from the rows themselves; this decides how to say it, and says nothing at all when
 * the run is over or when the agent is blocked on a question the operator can already see.
 */

/** Three dots keeping time — the typing indicator, for the same reason everyone else uses it. */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    // Decorative: every caller pairs it with a word, and the word is what a screen reader needs.
    <span aria-hidden className={cn("inline-flex items-center gap-[3px]", className)}>
      <span className="thinking-dot size-1 rounded-full bg-current" />
      <span className="thinking-dot size-1 rounded-full bg-current" />
      <span className="thinking-dot size-1 rounded-full bg-current" />
    </span>
  );
}

/** The line under the transcript. Present whenever the agent is working, absent otherwise. */
export function AgentActivityLine({ activity }: { activity: AgentActivity }) {
  return (
    <p
      // Announced, because it is the answer to "is this thing still alive" and the operator may
      // well be reading it with the panel out of focus. `polite`: it must never cut across the
      // agent's own output.
      aria-live="polite"
      data-agent-activity={activity.kind}
      className="flex items-center gap-2 font-mono text-2xs text-muted-foreground/80"
    >
      {activity.kind === "launching" ? (
        // A spinner, not the dots: this is a machine starting, not a model composing, and it is
        // the one activity here that ends in a state change rather than in more output.
        <LoaderCircle aria-hidden className="spinner size-3 shrink-0" />
      ) : (
        <ThinkingDots />
      )}
      {label(activity)}
    </p>
  );
}

/**
 * The wording.
 *
 * Named after what is actually happening, never a generic "working": an operator who can see
 * that the agent has been in `Bash` for ninety seconds knows to go look at the command, and one
 * told only that something is in progress does not.
 */
function label(activity: AgentActivity): string {
  switch (activity.kind) {
    case "launching":
      return "Launching the agent…";
    case "tool":
      return `Running ${activity.name}…`;
    case "writing":
      return "Writing…";
    default:
      return "Thinking…";
  }
}

/**
 * The empty terminal of a Task that was just launched.
 *
 * The panel used to say "No agent output yet. Launch the task to start a run." for the whole
 * startup window — advice to do the thing the operator had just done, under a state badge
 * already reading Running. This says what is going on instead, and says how long it is expected
 * to take, because the second sentence is what stops someone pressing Launch again.
 */
export function LaunchingPanel() {
  return (
    <div
      aria-live="polite"
      data-agent-activity="launching"
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <LoaderCircle aria-hidden className="spinner size-5 text-state-running" />
      <p className="font-medium text-sm">Launching the agent…</p>
      <p className="max-w-xs text-muted-foreground/70 text-xs leading-relaxed">
        Starting the session and checking out the worktree. The agent's first output appears here
        within a few seconds.
      </p>
    </div>
  );
}
