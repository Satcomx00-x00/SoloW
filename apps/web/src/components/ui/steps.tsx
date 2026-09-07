"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, Hourglass, X } from "lucide-react"

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
 * One colour per state, and never the colour alone: the marker carries a glyph or a number and
 * a screen reader gets the word. The colours are the Task-state tokens the board's columns and
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
        {status === "done" ? (
          <Check />
        ) : status === "failed" ? (
          <X />
        ) : status === "waiting" ? (
          <Hourglass />
        ) : (
          index + 1
        )}
      </span>
    </span>
  )
}

function Step({
  status = "upcoming",
  index,
  last = false,
  className,
  children,
  ...props
}: React.ComponentProps<"li"> & {
  status?: StepStatus
  /** Zero-based; drawn one-based in the marker. */
  index: number
  /** The last step draws no connector after itself. */
  last?: boolean
}) {
  const word = STATUS_WORD[status]
  return (
    <li
      data-slot="step"
      data-status={status}
      aria-current={status === "running" || status === "waiting" ? "step" : undefined}
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StepMarker status={status} index={index} />
        <span className={cn(stepLabelVariants({ status }))}>{children}</span>
        {word && <span className="sr-only"> — {word}</span>}
      </span>
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
