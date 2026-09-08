"use client";

import type { ReactNode } from "react";
import { CreateDisclosure } from "@/components/ui/create-disclosure";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The composition every Settings section is built from.
 *
 * ## What this replaces
 *
 * Twelve sections each shipped the same stock scaffold — a `Card`, a header, a permanently-open
 * create form, and a bordered `<ul className="divide-y">` nested inside the card. Three things
 * were wrong with it and none of them were fixable one section at a time.
 *
 * **Creation outranked inventory.** Every section opened on an empty form with a filled primary
 * button, and the things you actually own were demoted underneath it. You arrived at Secrets and
 * the loudest object on the page was a blank "Save secret" for a secret that did not exist, while
 * your three real credentials sat below in 13px rows. Four filled primary buttons competed in the
 * Harnesses group alone, against a design system that says there is rarely more than one. Here the
 * list *is* the section, and creating is one outline button that opens a form.
 *
 * **The wide layout parked emptiness beside a scroll.** The 18rem descriptor column carried two
 * lines of text and then nothing, for roughly four fifths of a group's height, while the form
 * beside it scrolled almost three screens. It is now sticky and it carries a *reading* — how many
 * slots are spent, how many things are stored, whether the last probe passed — so the column that
 * was the emptiest becomes the one that answers "is anything wrong here" without scrolling.
 *
 * **Nothing on the surface had state.** This is the settings screen of a control plane whose whole
 * design system exists so that "a reader who looks up from their editor should be able to tell
 * whether anything is waiting on them", and it could not tell you whether a single harness was
 * running. A concurrency cap was a number in a form. `status` is the seam that fixes that, and
 * `SettingsRow` carries the same idea per row.
 *
 * ## Why one component rather than a convention
 *
 * The old shape was a convention — "every section has exactly one Card holding one CardHeader and
 * one CardContent" — and `settings.tsx` then reached through it with ten `[&>div>[data-slot=card]]`
 * selectors to re-lay it out at `2xl`. That worked until a section put a dialog inside a card, at
 * which point the dialog was re-laid out as a settings row and the selector grew a `>` to exclude
 * it. A component owns its own grid, so the page does not have to describe one it cannot see.
 */
export function SettingsSection({
  id,
  title,
  caption,
  status,
  children,
}: {
  /** The anchor the navigator, the palette and `?section=` all scroll to. */
  id: string;
  title: string;
  caption: string;
  /**
   * The instrument reading for this section — what it is doing now, not what it is.
   *
   * Optional because a few sections genuinely have no present tense (the status bar has no state
   * beyond its own configuration). Where there is one, this is the most valuable thing on screen.
   */
  status?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} id={id} className="scroll-mt-4">
      <div className="surface-edge rounded-xl border bg-card shadow-sm 2xl:grid 2xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        {/*
          Sticky, so the name of the thing you are configuring stays beside the field you are
          editing rather than scrolling away at the top of a 700px form. `top-4` clears the
          scroll region's own padding; `self-start` is what lets a grid item be sticky at all.
        */}
        <div className="2xl:sticky 2xl:top-4 2xl:self-start space-y-2 border-b p-5 2xl:border-b-0 2xl:border-r 2xl:p-6">
          {/*
            A real `h2`. `CardTitle` renders a div, so this page used to offer a screen reader one
            landing point for a group two and a half screens tall.
          */}
          <h2 className="font-semibold text-base leading-none" id={headingId}>
            {title}
          </h2>
          <p className="text-muted-foreground text-xs leading-relaxed">{caption}</p>
          {status ? <div className="pt-1">{status}</div> : null}
        </div>
        <div className="min-w-0 space-y-4 p-5 2xl:p-6">{children}</div>
      </div>
    </section>
  );
}

/**
 * The reading in the rail: a dot, a number, a word.
 *
 * Never colour alone — the tone decides the dot's fill *and* the sentence says the same thing, so
 * this survives being read by someone who cannot tell the green from the amber, and by someone
 * hearing it. `tabular-nums` because these numbers change in place while you are looking at them.
 */
export function SectionStatus({
  tone = "idle",
  children,
}: {
  tone?: "idle" | "active" | "waiting" | "bad";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 font-medium text-xs tabular-nums",
        tone === "active" && "text-state-running",
        tone === "waiting" && "text-feedback-caution",
        tone === "bad" && "text-feedback-error",
        tone === "idle" && "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          // Only the live one moves. A dot that pulses when nothing is happening is a dot nobody
          // reads; the ambient cadence is the board's, because a settings page may show several.
          tone === "active" && "animate-pulse [animation-duration:var(--duration-spinner-ambient)]",
        )}
      />
      {children}
    </p>
  );
}

/**
 * The inventory: hairline-separated rows directly on the section's own surface.
 *
 * Not a bordered box inside the card. The old markup nested a `rounded-md border` list inside a
 * `rounded-xl border` card twenty-one times across this surface, which is two frames drawn around
 * one thing — the detector called it out on every pane and it is the single most visible reason
 * the page read as assembled rather than designed.
 */
export function SettingsRows({ children }: { children: ReactNode }) {
  return <ul className="-mx-1 divide-y">{children}</ul>;
}

/**
 * One thing you own, and what it is doing.
 *
 * `status` sits in its own column on the right rather than being appended to the metadata line,
 * so a column of ten rows can be scanned down a single edge for the one that is not idle. That is
 * the whole difference between a list of configuration and an instrument.
 */
export function SettingsRow({
  title,
  meta,
  status,
  actions,
  children,
}: {
  title: ReactNode;
  /** The identifying detail — kind, provider, command. Secondary to the name, never louder. */
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** Anything that belongs *under* the row: an expanded editor, a nested list of patterns. */
  children?: ReactNode;
}) {
  return (
    <li className="px-1 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="truncate font-medium text-sm">{title}</div>
          {meta ? <div className="text-muted-foreground text-xs">{meta}</div> : null}
        </div>
        {status ? <div className="shrink-0 pt-0.5">{status}</div> : null}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </li>
  );
}

/**
 * Creating something, as a disclosure rather than as the top of the page.
 *
 * The name Settings has always called this by; the primitive itself moved to
 * `ui/create-disclosure.tsx` once the sidebar's Workflows list needed the identical shape. See
 * that file for the reasoning — nothing about the behaviour changed, only where it lives.
 */
export const SettingsCreate = CreateDisclosure;

/**
 * Nothing here yet — said as a fact, not as an absence.
 *
 * Every section but one used to render its list unconditionally, so "you have no secrets" and
 * "the query has not come back" were the same picture. A settings page that looks identical
 * whether it is empty or broken is one people reload.
 */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-xs">
      {children}
    </p>
  );
}

/** The other half of that pair: what a section looks like while its list is still in flight. */
export function SettingsLoading({ rows = 2 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-3 py-1">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder, no identity
        <div className="space-y-1.5" key={i}>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      ))}
    </div>
  );
}

/**
 * A field and its label, at the one size the theme calls "control".
 *
 * Trivial, and worth having: the twelve sections had five spellings of "a label above an input"
 * between them, and the gaps differed by two pixels in three of them.
 */
export function SettingsField({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {/* `htmlFor` is supplied by every call site that renders a control of its own; the few that
          wrap one instead rely on the label containing it. */}
      <label className="font-medium text-sm" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}
