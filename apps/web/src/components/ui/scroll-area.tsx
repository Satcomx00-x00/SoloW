"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  viewportRef,
  onViewportScroll,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /**
   * The scrolling element itself. Radix owns it, so a caller that needs to *drive* the scroll —
   * follow a streaming log, bring a search match into view — has no other way to reach it.
   */
  viewportRef?: React.Ref<HTMLDivElement>
  /** Scroll events from that same element, for a caller tracking whether it is at the bottom. */
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        onScroll={onViewportScroll}
        data-slot="scroll-area-viewport"
        // Radix wraps `children` in its own `<div style="min-width:100%;display:table">` — a
        // table sizes to the widest *unbroken* line of its content (shrink-to-fit), not to the
        // Viewport's own width. A long line inside (a file path, a shell command) grows that
        // table past the visible panel — `overflow-x: hidden` on the Viewport keeps it from
        // being reachable, but nothing then makes an inner `truncate` fire, so it just sits
        // there as dead space, or a line meant to end in an ellipsis renders in full past the
        // edge instead. Forcing that wrapper to `display: block` makes it size to the Viewport
        // like an ordinary container, which is what every one of this app's usages needs — a
        // fixed-width, vertically scrolling column of content that wraps or truncates normally.
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:outline-1 [&>div]:block!"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
