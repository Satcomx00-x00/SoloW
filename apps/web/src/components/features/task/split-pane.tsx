"use client";

import { TASK_PANE_MAX_WIDTH, TASK_PANE_MIN_WIDTH } from "@solow/contracts";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A two-column split with a draggable divider, the arrangement a source-control panel has beside
 * an editor: the work on the left, the change under review in a fixed column on the right.
 *
 * The width lives with the caller, not here. This component reports where the divider was
 * dropped and renders whatever width it is given, so the caller owns persisting it — which
 * matters because the width is a per-user preference on the server, and a component that both
 * animated a drag and issued mutations would write one row per mouse move.
 *
 * Dragging is tracked on `window`, not on the divider: once the pointer is down, the gesture
 * belongs to the whole page. Listening on the element alone loses the drag the moment the
 * pointer outruns it, which on a fast drag is immediately.
 */
export function SplitPane({
  left,
  right,
  rightLabel,
  rightHeading,
  width,
  collapsed,
  onResize,
  onToggle,
}: {
  left: ReactNode;
  right: ReactNode;
  /** Names the right column for assistive technology and for the fold control. */
  rightLabel: string;
  /**
   * What the column's header row shows in place of its caption — a tab strip, when the column
   * holds more than one thing. The caption still names the column to assistive technology.
   */
  rightHeading?: ReactNode;
  width: number;
  collapsed: boolean;
  /** Called once, on release — not per mouse move. */
  onResize: (width: number) => void;
  onToggle: (collapsed: boolean) => void;
}) {
  // Mirrored locally so a drag is smooth at pointer speed; the caller's value is authoritative
  // whenever it changes underneath (a preference arriving from the server, another tab).
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shown = dragWidth ?? width;

  const stopDrag = useCallback(() => {
    setDragWidth((current) => {
      if (current !== null) onResize(current);
      return null;
    });
  }, [onResize]);

  useEffect(() => {
    if (dragWidth === null) return;

    const onMove = (event: PointerEvent) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      // The column is measured from the right edge, so the number means the same thing whatever
      // the window width — resizing the browser must not silently re-proportion the split.
      const next = Math.round(box.right - event.clientX);
      setDragWidth(Math.min(TASK_PANE_MAX_WIDTH, Math.max(TASK_PANE_MIN_WIDTH, next)));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [dragWidth, stopDrag]);

  const nudge = (delta: number) => {
    const next = Math.min(TASK_PANE_MAX_WIDTH, Math.max(TASK_PANE_MIN_WIDTH, shown + delta));
    onResize(next);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">{left}</div>

      {collapsed ? (
        // Folded: a rail wide enough to hit, so the column can always be brought back. A fold
        // with no visible way out is how a panel gets lost.
        <div className="flex shrink-0 items-start border-l px-1 py-3">
          <Button
            aria-label={`Show ${rightLabel}`}
            onClick={() => onToggle(false)}
            size="icon"
            variant="ghost"
          >
            <PanelRightOpen />
          </Button>
        </div>
      ) : (
        <>
          {/*
            An `<hr>` rather than a div with role="separator": that role IS an hr's implicit one,
            and with an orientation and a tabindex it becomes the ARIA window-splitter pattern
            without asserting a role the element does not already have. Its default margin and
            border are reset below, since here it is a full-height column divider.
          */}
          <hr
            aria-controls="task-changes-panel"
            aria-label={`Resize ${rightLabel}`}
            aria-orientation="vertical"
            aria-valuemax={TASK_PANE_MAX_WIDTH}
            aria-valuemin={TASK_PANE_MIN_WIDTH}
            aria-valuenow={shown}
            className={cn(
              // The line is a pixel; the thing you grab is twelve. A 4px hairline was a moving
              // target the cursor kept missing, so the hit area is drawn by `before:` around a
              // divider that stays as thin as it looks. Negative margins keep the columns where
              // they were — the extra width is borrowed from both sides, not added between them.
              "relative z-10 -mx-1.5 my-0 h-auto w-3 shrink-0 cursor-col-resize border-0 bg-transparent",
              "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors",
              "hover:before:w-0.5 hover:before:bg-ring/60 focus-visible:before:w-0.5 focus-visible:before:bg-ring focus-visible:outline-none",
              dragWidth !== null && "before:w-0.5 before:bg-ring",
            )}
            onKeyDown={(event) => {
              // A separator that only responds to a pointer is unusable without one. Home and
              // End go to the extremes, as every slider does.
              if (event.key === "ArrowLeft") nudge(24);
              else if (event.key === "ArrowRight") nudge(-24);
              else if (event.key === "Home") onResize(TASK_PANE_MAX_WIDTH);
              else if (event.key === "End") onResize(TASK_PANE_MIN_WIDTH);
              else return;
              event.preventDefault();
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragWidth(shown);
            }}
            tabIndex={0}
          />
          {/*
            The width is a ceiling, not a promise. A column pinned at the pixel width someone
            dragged it to on a wide screen keeps that width when the window is narrowed, and
            because it is `shrink-0` the run column beside it is what gives way: at 900px a
            617px preference left the terminal two pixels wide, pushed the composer's buttons out
            of their own form, and ran the panel past the right edge of the page. `min()` hands
            the excess back to the run, and the saved preference is untouched, so the arrangement
            returns intact on a wide window.
          */}
          <aside
            aria-label={rightLabel}
            className="flex min-h-0 shrink-0 flex-col"
            id="task-changes-panel"
            style={{ width: `min(${shown}px, 60%)` }}
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              {/* The label step, the one the navigator's section headers and every other panel
                  caption already use — 11px at 0.14em, not a third definition of "small caps". */}
              {rightHeading ?? (
                <h2 className="min-w-0 truncate font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
                  {rightLabel}
                </h2>
              )}
              <Button
                aria-label={`Hide ${rightLabel}`}
                onClick={() => onToggle(true)}
                size="icon"
                variant="ghost"
              >
                <PanelRightClose />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{right}</div>
          </aside>
        </>
      )}
    </div>
  );
}
