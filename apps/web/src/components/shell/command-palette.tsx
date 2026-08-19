"use client";

import { CornerDownLeft, Inbox, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { openCreateDialog } from "@/components/features/board/create-dialog-bus";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE } from "@/lib/issue-status";
import { SECTIONS } from "@/lib/navigation";
import { STATE_LABELS, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * Command palette (⌘K) — the app's search surface.
 *
 * Searching happens on the server. Filtering the client's copy of the list only works while the
 * whole list is in the client, which stops being true the moment a Workspace has a few hundred
 * Tasks; `task.list` and `issue.list` both take a `query`, so the palette uses it and cmdk's own
 * filter is turned off. Debounced, because this fires per keystroke.
 *
 * Both Tasks and Issues are searched. Looking for "keypad" and being shown only one of the two
 * kinds it could be is the thing that sends people back to the board to look manually.
 */

/** Long enough that the first letter does not fire a query, short enough to feel immediate. */
const QUERY_DEBOUNCE_MS = 140;
const OPEN_EVENT = "gatecontrol:open-command-palette";

/** Opens the palette from anywhere — the rail's Search button, the header trigger. */
export function openCommandPalette() {
  document.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const debouncedQuery = useDebounced(query.trim(), QUERY_DEBOUNCE_MS);
  const searching = debouncedQuery.length > 0;

  // Only fetch while the palette is open: this component mounts on every page of the shell.
  const tasks = trpc.task.list.useQuery(searching ? { query: debouncedQuery } : {}, {
    enabled: open,
  });
  const issues = trpc.issue.list.useQuery(searching ? { query: debouncedQuery } : {}, {
    enabled: open,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Start each visit from a clean slate rather than the last search.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  /**
   * The create dialog lives on the board, so get there first and then ask. Already-on-board is
   * the common case and `push` to the current route is a no-op, so the dialog opens at once.
   * Issues have no create dialog any more (issue #15) — only Tasks do.
   */
  const create = useCallback(
    (kind: "task") => {
      setOpen(false);
      router.push("/board");
      openCreateDialog(kind);
    },
    [router],
  );

  const taskRows = tasks.data ?? [];
  const issueRows = issues.data ?? [];
  const loading = tasks.isFetching || issues.isFetching;
  const nothingFound = searching && !loading && taskRows.length === 0 && issueRows.length === 0;

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput
        placeholder="Search tasks and issues, or jump to a section…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {nothingFound && <CommandEmpty>No task or issue matches “{debouncedQuery}”.</CommandEmpty>}

        {/* Destinations and creation only when browsing; during a search they are noise. */}
        {!searching && (
          <>
            <CommandGroup heading="Go to">
              {SECTIONS.map((section) => (
                <CommandItem key={section.href} onSelect={() => go(section.href)}>
                  <section.icon className="text-muted-foreground" />
                  {section.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Create">
              <CommandItem onSelect={() => create("task")}>
                <Plus className="text-muted-foreground" />
                New task
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {taskRows.length > 0 && (
          <CommandGroup heading={searching ? `Tasks (${taskRows.length})` : "Recent tasks"}>
            {taskRows.slice(0, 8).map((task) => {
              const { icon: Icon, textClassName } = STATE_STYLE[task.state];
              return (
                <CommandItem key={task.id} value={task.id} onSelect={() => go(`/task/${task.id}`)}>
                  <Icon className={cn("shrink-0", textClassName)} strokeWidth={2.25} />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span className={cn("shrink-0 text-2xs", textClassName)}>
                    {STATE_LABELS[task.state]}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {issueRows.length > 0 && (
          <CommandGroup heading={searching ? `Issues (${issueRows.length})` : "Recent issues"}>
            {issueRows.slice(0, 8).map((issue) => (
              <CommandItem
                key={issue.id}
                value={issue.id}
                onSelect={() => go(`/issues/${issue.id}`)}
              >
                <Inbox className="shrink-0 text-muted-foreground" strokeWidth={2.25} />
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {issue.taskCount === 1 ? "1 task" : `${issue.taskCount} tasks`}
                </span>
                <span className={cn("shrink-0 text-2xs", ISSUE_STATUS_STYLE[issue.status].text)}>
                  {ISSUE_STATUS_LABELS[issue.status]}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      {/* The keys are the point of a palette; spelling them out is what makes it learnable. */}
      <div className="flex items-center gap-3 border-t px-3 py-2 text-2xs text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>
            <CornerDownLeft className="size-2.5" />
          </Kbd>
          open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd>
          close
        </span>
        {loading && <span className="ml-auto">Searching…</span>}
      </div>
    </CommandDialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border bg-muted/50 px-1 font-mono text-[10px] leading-none">
      {children}
    </kbd>
  );
}

/** The header affordance that opens the palette, and advertises the shortcut. */
export function CommandPaletteTrigger() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => setIsMac(navigator.platform.toLowerCase().includes("mac")), []);

  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="flex h-7 items-center gap-2 rounded-md border bg-background/50 py-0 pr-1 pl-2 text-muted-foreground text-xs transition-colors hover:border-ring/40 hover:text-foreground"
    >
      <Search className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">Search</span>
      <kbd className="rounded border bg-muted/50 px-1.5 py-px font-mono text-[10px] leading-[1.4]">
        {isMac ? "⌘" : "Ctrl"}K
      </kbd>
    </button>
  );
}
