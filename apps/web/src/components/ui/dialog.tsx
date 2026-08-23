"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/**
 * How wide the dialog gets to be. A single 512px box for everything was the old behaviour, and
 * it was wrong at both ends: a two-field form floated in dead space while the import list —
 * a checkbox, a number, a title and a badge per row — wrapped inside it.
 *
 * `md` is unchanged from that old default, so a dialog that names no size looks exactly as it
 * did. The cap is a max-width, never a fixed width: the `max-w-[calc(100%-2rem)]` below still
 * wins on a narrow viewport.
 */
const DIALOG_SIZE = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-[45rem]",
  xl: "sm:max-w-4xl",
} as const

export type DialogSize = keyof typeof DIALOG_SIZE

/**
 * The entrance curve. Radix toggles `data-[state]`, tailwindcss-animate supplies the keyframes,
 * and these two utilities decide how it feels: a strong ease-out so the box is most of the way
 * there almost immediately, at the short end of the modal range.
 *
 * `ease-out` and not `ease-in-out` — the dialog is *arriving*, and easing in delays the exact
 * moment the eye is waiting for. The global `prefers-reduced-motion` block in `globals.css`
 * already collapses every animation-duration to 0.01ms, so there is nothing to opt out of here.
 */
const DIALOG_MOTION =
  "duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1"

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  size = "md",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: DialogSize
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size}
        className={cn(
          // A column rather than a grid, and bounded: this is what lets `DialogBody` claim the
          // leftover height and scroll inside the dialog, keeping the title and the actions in
          // view. `overflow-y-auto` here is the fallback for a dialog that uses no body — it
          // scrolls as a whole instead of running off the bottom of the screen.
          "fixed top-[50%] left-[50%] z-50 flex max-h-[min(85vh,44rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-6 shadow-2xl shadow-black/40 outline-none",
          DIALOG_SIZE[size],
          DIALOG_MOTION,
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground/70 ring-offset-background transition-colors duration-100 hover:bg-accent hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex shrink-0 flex-col gap-1.5 pr-8 text-center sm:text-left",
        className
      )}
      {...props}
    />
  )
}

/**
 * The scrolling middle of a dialog, between a header and a footer that stay put.
 *
 * Optional: a short form does not need one and stacks exactly as it always did. It earns its
 * place when the content is a list — the import picker's issues, say — where the alternative is
 * a dialog that grows past the viewport and takes its own submit button off-screen with it.
 *
 * The negative inline margin puts the scrollbar against the dialog's edge while the content
 * keeps the padding, so a scrolled row does not appear to slide under the border.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mx-6 min-h-0 flex-1 overflow-y-auto px-6", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-base leading-none font-semibold tracking-tight",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
