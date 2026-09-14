"use client";

import { Clock, CornerDownLeft, Square, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { HoldButton } from "@/components/ui/hold-button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type ComposerSteer, matchSteers } from "./composer-steers";

/** What the hub said about the last thing we sent, in words an operator can act on. */
const ACK_MESSAGE: Record<string, string> = {
  agent_not_running: "No harness is running for this task. Nothing was sent.",
  frame_not_authorized: "This connection is not allowed to steer that task.",
  frame_malformed: "The message could not be read by the orchestrator.",
  // The harness is still running in all of these; only the question is over.
  permission_not_pending: "That request was already settled — by the deadline, or by someone else.",
  permission_option_unknown: "The harness no longer offers that option.",
  permission_unsupported: "This harness's protocol has no permission channel to answer on.",
  widget_not_pending: "That question was already answered — by the deadline, or by someone else.",
  widget_option_unknown: "The harness no longer offers that choice.",
};

/** The ack's error code as a sentence; the fallback for a code this build does not know. */
export function ackMessage(error: string | undefined): string {
  return ACK_MESSAGE[error ?? ""] ?? "The orchestrator refused that message.";
}

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
 * **A field that grows.** A steer is often a paragraph — "no, the other config file, the one
 * under `apps/`, and leave the lockfile alone" — and a single-line box made people write it as
 * one breathless sentence. Enter now breaks the line; ⌘↩ (Ctrl↩) sends, and the frame says so.
 *
 * **A message that waits.** The socket blinks — a hub restart, a laptop lid — and for those
 * seconds the box used to disable itself and say nothing about the message half-typed in it. A
 * draft sent while the stream is away is *queued* in the frame instead, and goes the moment the
 * stream is back (the workspace owns that flush, because it owns the socket). Only a Task that
 * is no longer Running has nothing to steer, and then the box says that, as before.
 *
 * **Stop is held, not confirmed.** Stopping discards nothing — the harness's changes stay in the
 * worktree and go to review — so it is not the irreversible act an `alertdialog` is for, and a
 * modal over it was one more "are you sure?" to click through. The button has to be held for
 * the fill to cross it instead; a stray click does nothing. And it stays live while the stream
 * is away: the moment an operator most wants a harness stopped is the moment it used to go grey
 * with no word why. A stop pressed then is queued exactly as a steer is, said so in the frame,
 * and dropped if the Task stops Running first — which is the rule that keeps it from reaching
 * the wrong run.
 *
 * **The hub's answer, in the frame.** A refused send used to be reported by an orphan line
 * under the form; it belongs inside the thing that was refused.
 *
 * **`/` for the usual asks.** Four canned steers (`composer-steers.ts`) behind a leading slash,
 * so "run the tests" is three keystrokes rather than a sentence typed for the tenth time.
 * `/stop` cannot hold a button for you, so it puts the focus on Stop and says what to do.
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
  queued = null,
  onDiscardQueued,
  stopQueued = false,
  onQueueStop,
  onDiscardStop,
  ackError = null,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** True while there is a live harness to reach *right now*: the message goes on send. */
  canSteer: boolean;
  /** True while a harness exists to reach at all — a send with no stream is queued, not lost. */
  isRunning: boolean;
  /** A message waiting for the stream to come back, shown until it goes. */
  queued?: string | null;
  onDiscardQueued?: (() => void) | undefined;
  /** A stop waiting for the stream to come back. */
  stopQueued?: boolean;
  /** Stop pressed while the stream is away: hold it until the stream is back. */
  onQueueStop?: (() => void) | undefined;
  onDiscardStop?: (() => void) | undefined;
  /** The hub's refusal of the last send, as its wire code; rendered in words. */
  ackError?: string | null;
}) {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => setIsMac(navigator.platform.toLowerCase().includes("mac")), []);
  const [highlighted, setHighlighted] = useState(0);
  // `/stop` was picked: the focus goes to Stop and the frame says to hold it, until the next
  // keystroke or the stop itself.
  const [stopHint, setStopHint] = useState(false);
  const stopButton = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  const steers = isRunning ? matchSteers(value) : [];
  const menuOpen = steers.length > 0;
  // The highlight is clamped, not reset: narrowing from `/` to `/st` keeps the cursor where it
  // was when that row survived, and pulls it onto the last row when it did not.
  const active = Math.min(highlighted, Math.max(steers.length - 1, 0));

  const pick = (steer: ComposerSteer) => {
    if (steer.action === "stop") {
      onChange("");
      setStopHint(true);
      stopButton.current?.focus();
      return;
    }
    onChange(steer.text ?? "");
  };

  // The stop, wherever it lands: on the socket now, or in the queue until there is one.
  const stop = () => {
    setStopHint(false);
    if (canSteer) onStop();
    else onQueueStop?.();
  };

  const submit = () => {
    if (!value.trim() || !isRunning) return;
    onSubmit();
  };

  // Not running is not "disabled": there is no field to fill and nothing to press, so a form
  // of greyed controls was three dead targets and a placeholder nobody could read. One line,
  // the height the form has, so the terminal above does not move when a run starts.
  if (!isRunning) {
    return (
      <p
        className="flex h-11 shrink-0 items-center gap-2 border-t px-3 text-muted-foreground text-xs"
        data-composer-state="idle"
      >
        <Square aria-hidden className="size-3 shrink-0" />
        Not running — steering opens when a run starts.
      </p>
    );
  }

  return (
    <form
      // Wraps rather than crushes. Send and Stop have a fixed appetite, so on a narrow run column
      // a single row spent the remainder on the field and left a box two characters wide; below
      // the field's floor the actions drop to their own line instead, which is the arrangement
      // that still lets someone type.
      // A hairline row under the terminal, not a second frame: the region is the frame now.
      className="relative flex shrink-0 flex-wrap items-end justify-end gap-2 border-t bg-card/60 p-2 transition-colors focus-within:bg-card"
      data-composer-state={canSteer ? "live" : isRunning ? "away" : "idle"}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {menuOpen ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Steers"
          className="absolute inset-x-2 bottom-full mb-1 overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
        >
          {steers.map((steer, index) => (
            <div
              key={steer.command}
              id={`${listId}-${index}`}
              role="option"
              // Focus stays in the textarea; `aria-activedescendant` names the row instead.
              tabIndex={-1}
              aria-selected={index === active}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs",
                index === active ? "bg-accent text-accent-foreground" : "text-foreground/80",
              )}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(e) => {
                // Before the textarea loses focus, so the pick lands and the field keeps it.
                e.preventDefault();
                pick(steer);
              }}
            >
              <span className="font-mono text-muted-foreground">/{steer.command}</span>
              <span className="truncate">{steer.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-40 flex-1 flex-col gap-1">
        <label className="sr-only" htmlFor="harness-input">
          Message the harness
        </label>
        <Textarea
          id="harness-input"
          value={value}
          onChange={(e) => {
            setStopHint(false);
            onChange(e.target.value);
          }}
          disabled={!isRunning}
          rows={1}
          role={menuOpen ? "combobox" : undefined}
          aria-controls={menuOpen ? listId : undefined}
          aria-expanded={menuOpen ? true : undefined}
          aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
          placeholder={
            isRunning
              ? canSteer
                ? "Message the harness… ( / for the usual asks)"
                : "The stream is away. A message sent now goes when it is back."
              : "The harness is not running, so there is nothing to steer."
          }
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlighted((active + 1) % steers.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlighted((active - 1 + steers.length) % steers.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const steer = steers[active];
                if (steer) pick(steer);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onChange("");
                return;
              }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          // A floor, not a fixed width, and a ceiling: the field grows with the draft until it
          // would start eating the terminal above it, then scrolls.
          className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none focus-visible:border-0"
        />
        {queued ? (
          <p
            className="flex items-center gap-1.5 px-1 text-2xs text-feedback-caution"
            data-composer-queued
          >
            <Clock aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              Queued — sends when the stream is back: “{queued}”
            </span>
            {onDiscardQueued ? (
              <button
                type="button"
                className="ml-auto inline-flex h-6 shrink-0 items-center gap-0.5 rounded px-1 text-muted-foreground hover:text-foreground"
                onClick={onDiscardQueued}
              >
                <X aria-hidden className="size-3" /> Discard
              </button>
            ) : null}
          </p>
        ) : null}
        {stopQueued ? (
          <p
            className="flex items-center gap-1.5 px-1 text-2xs text-feedback-caution"
            data-composer-stop-queued
          >
            <Clock aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">Stop queued — goes when the stream is back.</span>
            {onDiscardStop ? (
              <button
                type="button"
                className="ml-auto inline-flex h-6 shrink-0 items-center gap-0.5 rounded px-1 text-muted-foreground hover:text-foreground"
                onClick={onDiscardStop}
              >
                <X aria-hidden className="size-3" /> Discard
              </button>
            ) : null}
          </p>
        ) : null}
        {stopHint ? (
          <p className="px-1 text-2xs text-muted-foreground" role="status">
            Hold Stop — the button, or Space on it — to stop the harness. Nothing is discarded.
          </p>
        ) : null}
        {ackError ? (
          <p className="px-1 text-2xs text-feedback-error" role="alert">
            {ackMessage(ackError)}
          </p>
        ) : null}
      </div>
      {/* `pointer-coarse`: a thumb gets a 44px row; a mouse keeps the console's 32px. */}
      <Button
        type="submit"
        disabled={!isRunning || !value.trim()}
        className="pointer-coarse:h-11 pointer-coarse:px-4"
      >
        <CornerDownLeft /> Send
        <kbd className="ml-0.5 font-mono text-2xs opacity-80 tracking-widest">
          {isMac ? "⌘" : "Ctrl"}↩
        </kbd>
      </Button>
      <HoldButton
        ref={stopButton}
        type="button"
        variant="outline"
        disabled={!isRunning || stopQueued}
        onConfirm={stop}
        hint={canSteer ? "Hold to stop" : "Hold to queue the stop"}
        className="pointer-coarse:h-11 pointer-coarse:px-4"
      >
        <Square /> Stop
      </HoldButton>
    </form>
  );
}
