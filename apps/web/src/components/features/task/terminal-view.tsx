"use client";

import { ArrowDown, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { AgentActivityLine, LaunchingPanel } from "./agent-activity";
import { EmptyPanel } from "./empty-panel";
import { findMatches, stepMatch } from "./terminal-search";
import { agentActivity, type TranscriptRow } from "./transcript";
import { Transcript } from "./transcript-view";

/**
 * The terminal: the transcript, plus the two controls a log viewer is unusable without.
 *
 * **Following the tail.** A run streams for minutes, and a panel that does not follow it makes
 * the operator scroll after every chunk; one that follows unconditionally yanks the view away
 * the moment they scroll back to read something. So it follows by default and *stops the instant
 * they scroll up*, which is the rule every terminal, editor and log viewer already uses — the
 * toggle then says which mode they are in and puts them back. Turning it on scrolls to the
 * bottom, because a follow that starts wherever you happened to be is not following anything.
 *
 * **Finding a string.** A finished run is hundreds of rows and the interesting one is never on
 * screen. ⌘F / Ctrl+F opens the bar, Enter and Shift+Enter walk the matches, Escape closes it —
 * the bindings from the editors this borrows from, because a find bar that invents its own is a
 * find bar people fight.
 *
 * Both live here rather than in `Transcript`, which stays a pure list of memoised rows: this owns
 * the viewport, and following and scrolling-to-a-match are both things you do *to* a viewport.
 *
 * **Saying that it is alive.** A run is mostly silence — the launch, a long tool call, a thinking
 * block — and a settled transcript looks the same whether the agent is composing or has hung. So
 * the foot of the list carries a line naming what is happening, and an empty terminal under a
 * running Task says the agent is starting rather than inviting the operator to start it again.
 */
export function TerminalView({
  rows,
  elided,
  isRunning = false,
  onRespondPermission,
  onRespondWidget,
}: {
  rows: readonly TranscriptRow[];
  /** How many earlier events a summary stands in for, if any. */
  elided: number;
  /** Whether an agent is on the other end. Nothing below the transcript moves when it is not. */
  isRunning?: boolean;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onRespondWidget?: ((widgetId: string, values: string[], text?: string) => void) | undefined;
}) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchInput = useRef<HTMLInputElement | null>(null);

  const matches = useMemo(() => findMatches(rows, query), [rows, query]);
  const activeMatch = matches[active] ?? null;
  const activity = useMemo(() => agentActivity(rows, isRunning), [rows, isRunning]);

  const scrollToBottom = useCallback(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Follow the tail. Keyed on the row count *and* the last row's length: a streaming turn grows
  // one block rather than adding rows, so a count alone would stop following mid-answer.
  const tailLength = rows[rows.length - 1]?.kind === "text" ? rows[rows.length - 1]?.id : "";
  const lastText = rows[rows.length - 1];
  const tailSize = lastText?.kind === "text" ? lastText.text.length : 0;
  // `activity` is in here because it is a row-height change like any other: the line appearing
  // when a tool call starts would otherwise push the tail under the fold without following it.
  const activityKey = activity ? `${activity.kind}:${"name" in activity ? activity.name : ""}` : "";
  // The extra dependencies are the point, not an oversight: the effect's body reads none of them,
  // and re-running when they change is precisely what keeps the view pinned to the tail as output
  // arrives. Dropping them — which is what the rule asks for — stops the terminal following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on growth, by design
  useEffect(() => {
    if (following) scrollToBottom();
  }, [following, scrollToBottom, rows.length, tailSize, tailLength, activityKey]);

  /**
   * Leaving the bottom turns following off; coming back turns it on. The threshold is generous
   * on purpose — "at the bottom" has to survive a rounding error and a half-rendered row, or the
   * toggle flickers while output streams.
   */
  const onScroll = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setFollowing(atBottom);
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus after paint, and select what is there so a second ⌘F replaces the old term.
    requestAnimationFrame(() => searchInput.current?.select());
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const go = useCallback(
    (by: 1 | -1) => {
      const next = stepMatch(matches.length, active, by);
      if (next !== null) setActive(next);
    },
    [matches.length, active],
  );

  // ⌘F / Ctrl+F belongs to the panel while the panel is on screen. Escape closes rather than
  // clearing in place, so the key that means "stop what I am doing" does exactly that.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // A new search starts from the top of the matches rather than wherever the last one ended,
  // and resetting whenever `matches` changed would fight the arrival of new output.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the query, not its matches
  useEffect(() => setActive(0), [query]);

  // Bring the active match into view. Queried from the DOM rather than threaded back through
  // refs: the row that owns it is memoised and three components down, and what has to move is
  // this viewport.
  useEffect(() => {
    if (!activeMatch) return;
    const el = viewport.current?.querySelector("[data-match-active='true']");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatch]);

  return (
    <div className="surface-edge flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-[oklch(0.13_0.008_265)]">
      {/*
        A fixed-height strip, not a row that sizes to whatever is in it: the find bar swaps a
        button for an input and back, and a bar that grew and shrank with them would shove the
        transcript up and down every time you pressed ⌘F. `h-9` is the tallest thing it ever
        holds, so nothing inside can clip it and nothing moves when the contents change.
      */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-black/25 px-2">
        {/*
          A toggle, drawn as one. The label stays put and the dot carries the state — a button
          whose *text* changes between "on" and "off" makes you read it to find out what pressing
          it would do, and a filled button shouting its own state was the loudest thing in a bar
          that should be quiet.
        */}
        <button
          type="button"
          aria-pressed={following}
          aria-label={`Auto-scroll ${following ? "on" : "off"}`}
          onClick={() => {
            const next = !following;
            setFollowing(next);
            if (next) scrollToBottom();
          }}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-2xs transition-colors duration-100 hover:bg-white/5",
            following ? "text-foreground/80" : "text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full transition-colors duration-150",
              following ? "bg-state-running" : "bg-muted-foreground/40",
            )}
          />
          Auto-scroll
        </button>

        {/* Only worth saying while it is off — that is the state you might not have chosen. */}
        {!following && (
          <button
            type="button"
            onClick={() => {
              setFollowing(true);
              scrollToBottom();
            }}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors duration-100 hover:bg-white/5 hover:text-foreground"
          >
            <ArrowDown aria-hidden className="size-3" /> Jump to latest
          </button>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {searchOpen ? (
            <>
              <div className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/70"
                />
                <Input
                  ref={searchInput}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeSearch();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      go(e.shiftKey ? -1 : 1);
                    }
                  }}
                  placeholder="Find in terminal"
                  aria-label="Find in terminal"
                  className="h-6 w-52 rounded-md pl-7 font-mono text-2xs"
                />
              </div>
              <span
                className="min-w-16 text-right font-mono text-2xs text-muted-foreground tabular-nums"
                // Announced, because the count answers what was just typed and sits nowhere near
                // the input a screen-reader user is in.
                aria-live="polite"
              >
                {query.trim() === ""
                  ? ""
                  : matches.length === 0
                    ? "no results"
                    : `${active + 1} of ${matches.length}`}
              </span>
              <div className="flex items-center">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Previous match"
                  disabled={matches.length === 0}
                  onClick={() => go(-1)}
                >
                  <ChevronUp />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Next match"
                  disabled={matches.length === 0}
                  onClick={() => go(1)}
                >
                  <ChevronDown />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close find"
                  onClick={closeSearch}
                >
                  <X />
                </Button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={openSearch}
              className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors duration-100 hover:bg-white/5 hover:text-foreground"
            >
              <Search aria-hidden className="size-3" /> Find
              {/* The shortcut, stated rather than discovered — the same idiom the command
                  palette and the create menu already use. */}
              <kbd className="ml-0.5 font-mono text-[10px] text-muted-foreground/60 tracking-widest">
                ⌘F
              </kbd>
            </button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} onViewportScroll={onScroll}>
        {rows.length > 0 ? (
          <>
            {elided > 0 && (
              <p className="border-b px-4 py-2 font-mono text-2xs text-muted-foreground/70">
                … {elided} earlier events summarised — see the Conversation tab
              </p>
            )}
            <Transcript
              rows={rows}
              onRespondPermission={onRespondPermission}
              onRespondWidget={onRespondWidget}
              search={{ query, active: activeMatch }}
            />
            {/* Inside the scroll region, so following the tail follows this too — it is the last
                thing in the transcript for as long as there is nothing after it. */}
            {activity && (
              <div className="px-4 pb-4">
                <AgentActivityLine activity={activity} />
              </div>
            )}
          </>
        ) : isRunning ? (
          <LaunchingPanel />
        ) : (
          <EmptyPanel label="No agent output yet. Launch the task to start a run." />
        )}
      </ScrollArea>
    </div>
  );
}
