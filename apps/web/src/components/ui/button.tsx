import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { LoaderCircle } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Sizes are a 4-step ladder on a 4px grid — 24 / 28 / 32 / 36 — and inputs, selects and the
 * command bar use the same numbers, so a button never sits half a pixel off the field beside it.
 * `default` is 32px rather than shadcn's 36: this is a console read beside an editor, not a
 * marketing page.
 *
 * Every variant presses. `active:translate-y-px` with a 100ms transition is enough to feel
 * mechanical without becoming a bounce, and it is a transform, so it composites.
 */
const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap",
    "transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-100 ease-out",
    "outline-none active:translate-y-px",
    // Disabled reads as switched off, not merely faded: no pointer, no press, lower contrast.
    "disabled:pointer-events-none disabled:opacity-45 disabled:active:translate-y-0",
    "aria-invalid:border-destructive",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  ],
  {
    variants: {
      variant: {
        // The inset top highlight is the same trick the panels use: it gives a filled control
        // a lit edge so it reads as raised rather than as a painted rectangle.
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_0_oklch(1_0_0/18%)] hover:bg-primary/90 active:bg-primary/95",
        destructive:
          "bg-destructive text-white shadow-[inset_0_1px_0_0_oklch(1_0_0/18%)] hover:bg-destructive/90 active:bg-destructive/95",
        outline:
          "border bg-transparent hover:border-ring/40 hover:bg-accent hover:text-accent-foreground active:bg-accent/80",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/75 active:bg-secondary/85",
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:bg-accent/80",
        link: "text-primary underline-offset-4 hover:underline active:translate-y-0",
      },
      size: {
        xs: "h-6 gap-1 px-2 text-2xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 px-2.5 text-xs",
        default: "h-8 px-3 text-sm",
        lg: "h-9 px-4 text-sm",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /**
     * Swaps the leading icon for a spinner and blocks the control. Built in rather than left to
     * each call site, so a pending action can never be clicked twice — which for this app means
     * a second review decision on the same session.
     */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {/* `asChild` hands rendering to the child, so the spinner is only ours to add when it is not. */}
      {asChild ? (
        children
      ) : (
        <>
          {loading && <LoaderCircle className="animate-spin" aria-hidden />}
          {children}
        </>
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
