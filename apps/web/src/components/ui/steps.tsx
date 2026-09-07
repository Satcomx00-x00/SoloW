"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, X } from "lucide-react"

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

const stepMarkerVariants = cva(
  "flex size-5 shrink-0 items-center justify-center rounded-full border font-medium text-2xs tabular-nums transition-colors [&>svg]:size-3",
  {
    variants: {
      status: {
        upcoming: "border-border bg-background text-muted-foreground",
        current:
          "border-primary bg-primary text-primary-foreground ring-4 ring-primary/15",
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
      current: "font-medium text-foreground",
      done: "text-foreground/80",
      failed: "font-medium text-state-failed",
    },
  },
  defaultVariants: {
    status: "upcoming",
  },
})

/** What a marker says out loud: the number is enough for a step still to come. */
const STATUS_WORD: Record<NonNullable<StepStatus>, string | null> = {
  upcoming: null,
  current: "current",
  done: "done",
  failed: "failed",
}

type StepStatus = VariantProps<typeof stepMarkerVariants>["status"]

function Step({
  status = "upcoming",
  index,
  last = false,
  className,
  children,
  ...props
}: React.ComponentProps<"li"> &
  VariantProps<typeof stepMarkerVariants> & {
    /** Zero-based; drawn one-based in the marker. */
    index: number
    /** The last step draws no connector after itself. */
    last?: boolean
  }) {
  const word = STATUS_WORD[status ?? "upcoming"]
  return (
    <li
      data-slot="step"
      data-status={status}
      aria-current={status === "current" ? "step" : undefined}
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className={cn(stepMarkerVariants({ status }))}>
          {status === "done" ? <Check /> : status === "failed" ? <X /> : index + 1}
        </span>
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

export { Step, Steps, stepMarkerVariants }
export type { StepStatus }
