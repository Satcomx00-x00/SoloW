import * as React from "react"

import { cn } from "@/lib/utils"

/** Matches `Input`'s surface and focus treatment; height is left to the caller. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-background/40 px-2.5 py-2 text-sm",
        "transition-[color,background-color,border-color] duration-100 outline-none",
        "placeholder:text-muted-foreground/70 hover:border-ring/30 focus-visible:border-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
