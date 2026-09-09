"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Hourglass, X } from "lucide-react"

import { cn } from "@/lib/utils"

function Steps({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="steps"
      className={cn("flex w-full flex-wrap items-center gap-y-1.5", className)}
      {...props}
    />
  )
}

/**
 * One colour per state, and never the colour alone: the marker carries its number — or a glyph
 * for the two states that are not simply a position — and a screen reader gets the word. The colours are the Task-state tokens the board's columns and
 * badges use — green done, blue running, orange waiting on someone (review), red failed — so
 * a step and the column it corresponds to can never disagree; a step still to come is uncoloured.
 */
const stepMarkerVariants = cva(
  "relative flex size-5 shrink-0 items-center justify-center rounded-full border font-medium text-2xs tabular-nums transition-colors [&>svg]:size-3",
  {
    variants: {
      status: {
        upcoming: "border-border bg-background text-muted-foreground",
        running: "border-state-running bg-state-running text-background ring-4 ring-state-running/20",
        waiting: "border-state-review bg-state-review text-background ring-4 ring-state-review/20",
        done: "border-state-done bg-state-done text-background",
        failed: "border-state-failed bg-state-failed text-background",
      },
    },
    defaultVariants: {
      status: "upcoming",
    },
  }
)

const stepLabelVariants = cva("max-w-64 truncate text-xs", {
  variants: {
    status: {
      upcoming: "text-muted-foreground",
      running: "font-medium text-state-running",
      waiting: "font-medium text-state-review",
      done: "text-foreground/80",
      failed: "font-medium text-state-failed",
    },
  },
  defaultVariants: {
    status: "upcoming",
  },
})

type StepStatus = NonNullable<VariantProps<typeof stepMarkerVariants>["status"]>

/** What a marker says out loud: the number is enough for a step still to come. */
const STATUS_WORD: Record<StepStatus, string | null> = {
  upcoming: null,
  running: "running",
  waiting: "waiting",
  done: "done",
  failed: "failed",
}

function StepMarker({
  status,
  index,
  className,
}: {
  status: StepStatus
  index: number
  className?: string
}) {
  return (
    <span aria-hidden className={cn(stepMarkerVariants({ status }), className)}>
      {status === "running" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-state-running opacity-40" />
      )}
      <span className="relative inline-flex">
        {status === "failed" ? <X /> : status === "waiting" ? <Hourglass /> : index + 1}
      </span>
    </span>
  )
}

/**
 * A step, and — when the caller hands it an `onSelect` — a tab that picks it.
 *
 * Additive: without `onSelect` this renders exactly the read-only `<li>` it always did, so a
 * strip that only reports progress is untouched. With it, the step becomes a real `<button
 * role="tab">` inside an `<li role="presentation">` — the markup the APG's own tabs-in-a-list
 * example uses, and the reason the `<li>` steps aside is that a `tablist` has to own its tabs
 * directly; a listitem in between is a listitem the tablist does not recognise as a tab.
 *
 * `aria-current` moves onto the button in that mode rather than being dropped, because it is the
 * one thing selection must never absorb: `aria-current="step"` says *the run is here*, and
 * `aria-selected` says *this is what you are looking at*. They are routinely different steps —
 * that is the entire point of being able to click back to an earlier one — and a presentational
 * `<li>` is out of the accessibility tree, so an attribute left on it would simply vanish.
 */
function Step({
  status = "upcoming",
  index,
  last = false,
  className,
  selected = false,
  onSelect,
  controls,
  tabId,
  children,
  ...props
}: React.ComponentProps<"li"> & {
  status?: StepStatus
  /** Zero-based; drawn one-based in the marker. */
  index: number
  /** The last step draws no connector after itself. */
  last?: boolean
  /** Whether this step is the one on screen. Only meaningful alongside `onSelect`. */
  selected?: boolean
  /** Makes the step a tab. Omitted, the step is not interactive at all. */
  onSelect?: (() => void) | undefined
  /** Id of the panel the tab shows, for `aria-controls`. */
  controls?: string | undefined
  /** Id of the tab itself, so the panel can point back at it. */
  tabId?: string | undefined
}) {
  const word = STATUS_WORD[status]
  const here = status === "running" || status === "waiting"
  const body = (
    <>
      <StepMarker status={status} index={index} />
      <span className={cn(stepLabelVariants({ status }))}>{children}</span>
      {word && <span className="sr-only"> — {word}</span>}
    </>
  )
  return (
    <li
      data-slot="step"
      data-status={status}
      data-selected={onSelect ? selected : undefined}
      role={onSelect ? "presentation" : undefined}
      aria-current={!onSelect && here ? "step" : undefined}
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      {...props}
    >
      {onSelect ? (
        <button
          type="button"
          role="tab"
          id={tabId}
          aria-controls={controls}
          aria-selected={selected}
          aria-current={here ? "step" : undefined}
          // Roving tabindex: the strip is one tab stop, and the arrow keys walk it. A dozen
          // steps that each swallowed a Tab press would put the terminal below them a dozen
          // presses away.
          tabIndex={selected ? 0 : -1}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            // Selection is drawn as a held-down surface, never as a colour: the marker's colours
            // are the Task-state family and are already spoken for by what the step is *doing*.
            selected ? "bg-muted ring-1 ring-border" : "hover:bg-muted/60"
          )}
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">{body}</span>
      )}
      {!last && (
        <span
          aria-hidden
          className={cn(
            "h-px w-8 shrink-0",
            status === "done" ? "bg-state-done/60" : "bg-border"
          )}
        />
      )}
    </li>
  )
}

export { Step, StepMarker, Steps, stepLabelVariants, stepMarkerVariants, STATUS_WORD }
export type { StepStatus }
