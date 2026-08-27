import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // No `border-transparent` here: it is a Tailwind utility, and utilities beat the components
  // layer where `.badge-soft` lives — so a transparent border on the base would silently win over
  // every soft variant's border colour. The variants that want no border say so themselves.
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      // Soft, not filled. Every variant that carries a colour states it as `--badge-color` and
      // lets `.badge-soft` (globals.css) do the mixing, so there is one definition of "soft" in
      // the app rather than one per component. `ghost` and `link` are not badges visually and
      // keep their own treatment.
      variant: {
        default: "badge-soft [--badge-color:var(--primary)]",
        secondary: "badge-soft [--badge-color:var(--muted-foreground)]",
        destructive:
          "badge-soft [--badge-color:var(--destructive)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "badge-soft [--badge-color:var(--muted-foreground)] [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "border-transparent [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "border-transparent text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
