import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 32px tall to match `Button` size `default`, so a field and the button beside it share a
 * baseline. Focus is the app-wide `:focus-visible` outline from globals.css — the ring classes
 * that used to live here drew a second one.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-background/40 px-2.5 py-1 text-sm",
        "transition-[color,background-color,border-color] duration-100 outline-none",
        "selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground/70",
        "hover:border-ring/30 focus-visible:border-ring/50",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
