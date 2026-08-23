"use client";

import { TASK_PANE_MAX_WIDTH, TASK_PANE_MIN_WIDTH } from "@gatecontrol/contracts";
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
  width,
  collapsed,
  onResize,
  onToggle,
}: {
  left: ReactNode;
  right: ReactNode;
  /** Names the right column for assistive technology and for the fold control. */
  rightLabel: string;
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
              "m-0 h-auto w-1 shrink-0 cursor-col-resize border-0 border-l transition-colors",
              "hover:bg-ring/40 focus-visible:bg-ring/60 focus-visible:outline-none",
              dragWidth !== null && "bg-ring/60",
            )}
            onKeyDown={(event) => {
              // A separator that only responds to a pointer is unusable without one.
              if (event.key === "ArrowLeft") nudge(24);
              else if (event.key === "ArrowRight") nudge(-24);
              else return;
              event.preventDefault();
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragWidth(shown);
            }}
            tabIndex={0}
          />
          <aside
            aria-label={rightLabel}
            className="flex min-h-0 shrink-0 flex-col"
            id="task-changes-panel"
            style={{ width: shown }}
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {rightLabel}
              </h2>
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
