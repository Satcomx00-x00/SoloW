"use client";

import { type ComponentProps, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A button that has to be held to fire.
 *
 * For an action that should not happen on a stray click but does not throw work away — stopping
 * a harness, whose changes stay in the worktree and go to review. Those used to open an
 * `alertdialog`, which is the surface for "this cannot be undone", and a modal over a routine
 * act is a modal people learn to click through. Here the gesture is the safeguard: the fill
 * crosses the button over the hold and letting go early cancels, so the intent is the press
 * itself and nobody is asked "are you sure?" a second time.
 *
 * Keyboard users hold Space or Enter for the same length — `keydown` repeats while held, and the
 * first `keyup` cancels — and the hint under the label says so, because a hold is not a gesture
 * a button advertises on its own.
 */
export function HoldButton({
  onConfirm,
  holdMs = 400,
  hint = "Hold to confirm",
  className,
  children,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "asChild" | "loading"> & {
  onConfirm: () => void;
  holdMs?: number;
  /** Read to assistive technology and shown while holding. */
  hint?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintId = useId();

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onConfirm();
    }, holdMs);
  }, [disabled, holdMs, onConfirm]);

  // A hold that outlives the button — it unmounts mid-press — must not fire into nothing.
  useEffect(() => cancel, [cancel]);

  return (
    <span className="relative inline-flex flex-col items-center">
      <Button
        {...props}
        disabled={disabled}
        aria-describedby={hintId}
        data-holding={holding || undefined}
        className={cn("hold-fill overflow-hidden", className)}
        style={{ ["--hold-duration" as string]: `${holdMs}ms` }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // So a release outside the button still cancels; not every DOM has it (tests).
          e.currentTarget.setPointerCapture?.(e.pointerId);
          start();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onKeyDown={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          if (!e.repeat) start();
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") cancel();
        }}
        onBlur={cancel}
        // The click that follows a released press must not fire the action — the hold did or did
        // not, and a plain click is precisely the gesture this exists to refuse.
        onClick={(e) => e.preventDefault()}
      >
        {children}
      </Button>
      <span
        id={hintId}
        className={cn(
          "pointer-events-none absolute top-full mt-1 whitespace-nowrap text-2xs text-muted-foreground transition-opacity duration-100",
          holding ? "opacity-100" : "sr-only opacity-0",
        )}
      >
        {hint}
      </span>
    </span>
  );
}
