"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The app's one tab component, on Radix Tabs.
 *
 * Radix owns the contract that is easy to get wrong and was got wrong twice here: roving
 * tabindex, ←/→/Home/End, `aria-controls` from tab to panel, manual or automatic activation.
 * What this adds is everything a strip needs *beyond* the contract, so a feature never rolls
 * its own again:
 *
 * - **An indicator that travels.** One bar (or one pill, for the `default` variant) is measured
 *   under the active tab and moved there with a transform — never a per-tab underline that
 *   appears in one place and disappears in another. 150ms, ease-out, no bounce. Until the
 *   first measurement a CSS underline stands in, so server HTML is not bare.
 * - **Counts, said properly.** `count` draws the mono pill; it is `aria-hidden` and the number
 *   goes to `aria-describedby` instead, so a tab's accessible name stays exactly its label —
 *   the name a spec or a screen-reader user finds it by.
 * - **Overflow that scrolls.** The list never wraps to a second line. Past its width it scrolls,
 *   with a fade on whichever edge has more, and the active tab is brought into view.
 * - **Panels that stay.** `keepMounted` on a panel keeps it in the tree (a diff viewer holds
 *   which file is open) and hides it with the state attribute; it fades in when shown.
 */

const TabsOrientationContext = React.createContext<"horizontal" | "vertical">("horizontal");

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsOrientationContext.Provider value={orientation}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-orientation={orientation}
        orientation={orientation}
        className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
        {...props}
      />
    </TabsOrientationContext.Provider>
  );
}

const tabsListVariants = cva(
  [
    "group/tabs-list tabs-scroll relative inline-flex w-fit max-w-full items-center text-muted-foreground",
    "group-data-[orientation=horizontal]/tabs:overflow-x-auto group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  ],
  {
    variants: {
      variant: {
        // A segmented control: the pill slides behind the active tab.
        default: "justify-center rounded-lg bg-muted p-[3px]",
        // A row of labels over a hairline: the bar slides under the active one.
        line: "gap-1 rounded-none bg-transparent",
      },
      size: {
        sm: "group-data-[orientation=horizontal]/tabs:h-7",
        default: "group-data-[orientation=horizontal]/tabs:h-8",
        lg: "group-data-[orientation=horizontal]/tabs:h-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface Indicator {
  x: number;
  y: number;
  w: number;
  h: number;
}

function TabsList({
  className,
  variant = "default",
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  const orientation = React.useContext(TabsOrientationContext);
  const list = React.useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = React.useState<Indicator | null>(null);
  const [overflow, setOverflow] = React.useState<"none" | "start" | "end" | "both">("none");

  /**
   * Where the active tab is. Measured from the DOM rather than derived from the value, because
   * the list does not know the value — Radix does — and because a count arriving on a label
   * changes the width without any value changing. A mutation observer on `data-state` catches
   * the selection moving; a resize observer catches the labels reflowing.
   */
  const measure = React.useCallback(() => {
    const el = list.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    setIndicator(
      active
        ? { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight }
        : null,
    );
    const more = el.scrollWidth - el.clientWidth;
    if (more <= 1) setOverflow("none");
    else if (el.scrollLeft <= 1) setOverflow("end");
    else if (el.scrollLeft >= more - 1) setOverflow("start");
    else setOverflow("both");
  }, []);

  React.useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { attributes: true, attributeFilter: ["data-state"], subtree: true });
    const resizes = new ResizeObserver(measure);
    resizes.observe(el);
    return () => {
      mutations.disconnect();
      resizes.disconnect();
    };
  }, [measure]);

  // The active tab is brought into view when it changes — horizontally only, and inside the
  // list only, so this can never scroll the page under someone.
  React.useLayoutEffect(() => {
    const el = list.current;
    if (!el || !indicator || orientation !== "horizontal") return;
    const pad = 16;
    if (indicator.x < el.scrollLeft) el.scrollLeft = Math.max(0, indicator.x - pad);
    else if (indicator.x + indicator.w > el.scrollLeft + el.clientWidth)
      el.scrollLeft = indicator.x + indicator.w - el.clientWidth + pad;
  }, [indicator, orientation]);

  const horizontal = orientation === "horizontal";
  const style: React.CSSProperties | undefined = indicator
    ? variant === "line"
      ? horizontal
        ? { transform: `translateX(${indicator.x}px)`, width: indicator.w }
        : { transform: `translateY(${indicator.y}px)`, height: indicator.h }
      : {
          transform: `translate(${indicator.x}px, ${indicator.y}px)`,
          width: indicator.w,
          height: indicator.h,
        }
    : undefined;

  return (
    <TabsPrimitive.List
      ref={list}
      data-slot="tabs-list"
      data-variant={variant}
      data-size={size}
      data-measured={indicator ? "" : undefined}
      data-overflow={overflow}
      onScroll={measure}
      className={cn(tabsListVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      {indicator ? (
        <span
          aria-hidden
          data-slot="tabs-indicator"
          style={style}
          className={cn(
            "pointer-events-none absolute transition-[transform,width,height] duration-150 ease-out",
            variant === "line"
              ? cn(
                  "rounded-full bg-foreground",
                  horizontal ? "bottom-0 left-0 h-0.5" : "top-0 right-0 w-0.5",
                )
              : "top-0 left-0 rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30",
          )}
        />
      ) : null}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  count,
  countLabel = "items",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  /** A number beside the label — files, criteria, unread. Nothing is drawn for zero. */
  count?: number | null | undefined;
  /** What the number counts, for assistive technology: "3 files". */
  countLabel?: string;
}) {
  const countId = React.useId();
  const shown = typeof count === "number" && count > 0;
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      aria-describedby={shown ? countId : undefined}
      className={cn(
        // Above the sliding pill, which is drawn behind the strip.
        "relative z-10 inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 py-1 font-medium text-foreground/60 text-sm transition-colors duration-100 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[size=sm]/tabs-list:text-xs group-data-[size=lg]/tabs-list:px-2.5",
        "group-data-[orientation=horizontal]/tabs:h-[calc(100%-1px)] group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start",
        // The `default` pill and the `line` bar are drawn by the list's indicator once it has
        // measured; until then the active tab paints its own, so server HTML is not bare.
        "group-data-[variant=default]/tabs-list:data-[state=active]:bg-background group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm dark:group-data-[variant=default]/tabs-list:data-[state=active]:border-input dark:group-data-[variant=default]/tabs-list:data-[state=active]:bg-input/30",
        "group-data-[measured]/tabs-list:data-[state=active]:border-transparent group-data-[measured]/tabs-list:data-[state=active]:bg-transparent group-data-[measured]/tabs-list:data-[state=active]:shadow-none",
        "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100 after:absolute after:bg-foreground after:opacity-0 group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:right-0 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[measured]/tabs-list:after:opacity-0",
        className,
      )}
      {...props}
    >
      {children}
      {shown ? (
        <>
          <span
            aria-hidden
            className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground tabular-nums group-data-[variant=default]/tabs-list:bg-background/60"
          >
            {count}
          </span>
          {/* Hidden from the name's computation — a tab is "Changes", not "Changes 3 files" —
              and still what `aria-describedby` reads: a description may reference hidden text. */}
          <span id={countId} className="sr-only" aria-hidden>
            {count} {countLabel}
          </span>
        </>
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({
  className,
  keepMounted = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content> & {
  /**
   * Keep the panel in the tree while another tab is showing. For a panel that holds state —
   * which file a diff viewer has open, how far a log is scrolled — so that coming back to it is
   * coming back, not starting over. Hidden by state, and faded in on return.
   */
  keepMounted?: boolean;
}) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      {...(keepMounted ? { forceMount: true as const } : {})}
      className={cn(
        "flex-1 outline-none",
        keepMounted &&
          "transition-opacity duration-100 data-[state=inactive]:hidden starting:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
