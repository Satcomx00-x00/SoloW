"use client";

import type { SurfaceLayout } from "@solow/core";
import { CornerDownLeft, Inbox, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { type CreateKind, openCreateDialog } from "@/components/features/board/create-dialog-bus";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useSurfaceLayout } from "@/hooks/use-surface-layout";
import { useAppContext } from "@/lib/app-context";
import { COMMAND_GROUPS, type CommandActions, commandRegistry } from "@/lib/contributions";
import { WHOLE_PAGE } from "@/lib/paged";
import "@/lib/contributions-boot";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE } from "@/lib/issue-status";
import { STATE_LABELS, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * Command palette (⌘K) — the app's search surface, and a consumer of the command registry
 * (issue #3).
 *
 * The palette holds no list of commands. Destinations, "New task" and the Settings entries are
 * registrations resolved against the shell's `AppContext`, so a feature — or later a plugin —
 * adds an entry without this file being edited, and whether an entry applies is its own `when`
 * predicate rather than a branch here (AC-2, AC-4).
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
const OPEN_EVENT = "solow:open-command-palette";

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
  const tasks = trpc.task.list.useQuery(
    searching ? { ...WHOLE_PAGE, query: debouncedQuery } : WHOLE_PAGE,
    {
      enabled: open,
    },
  );
  const issues = trpc.issue.list.useQuery(
    searching ? { ...WHOLE_PAGE, query: debouncedQuery } : WHOLE_PAGE,
    {
      enabled: open,
    },
  );

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
   * Ask the shell to open a create/import dialog. No navigation any more: the dialogs live in
   * the header's `CreateMenu`, which is mounted on every route, so a palette command no longer
   * has to bounce through `/board` to reach one.
   */
  const create = useCallback((kind: CreateKind) => {
    setOpen(false);
    openCreateDialog(kind);
  }, []);

  /**
   * What a command is allowed to do, handed in rather than imported: a contributed command that
   * reached for the router itself would be exactly the coupling the registry removes, and it is
   * this object that a plugin permission prompt (#93) eventually attaches to.
   */
  const actions = useMemo<CommandActions>(() => ({ navigate: go, create }), [go, create]);

  // Read here and passed down, so the resolved list is arranged the way the operator arranged it
  // while `ContributedCommands` itself stays free of a query client (issue #3 AC-3).
  const { layout: commandLayout } = useSurfaceLayout(commandRegistry.surface);

  const taskRows = tasks.data?.items ?? [];
  const issueRows = issues.data?.items ?? [];
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

        {/* Commands only when browsing; during a search they are noise. This is the palette's
            own mode, not a judgement about any one command — which is why it gates the whole
            resolved list rather than naming anything in it. */}
        {!searching && <ContributedCommands actions={actions} layout={commandLayout} />}

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

/**
 * Everything the command registry resolved, grouped under its headings (issue #3).
 *
 * Exported so it can be tested against a registry without a router or a query client — the
 * palette around it is search, and this is the part that has to prove a contributed command
 * appears, a predicate keeps one out, and the order is the arranged one.
 *
 * A command that throws while running costs itself and nothing else, for the same reason the
 * registry swallows a throwing predicate: #93 will run these from a plugin.
 */
export function ContributedCommands({
  actions,
  layout,
}: {
  actions: CommandActions;
  /**
   * The surface's saved arrangement. Passed in rather than read here, so this stays renderable
   * against a registry with no router and no query client — which is what makes it testable at
   * all. `commands` is one of the arrangeable surfaces the preference API accepts, so a caller
   * that omits it would let a user set an order they never see applied.
   */
  layout?: SurfaceLayout | undefined;
}) {
  const appContext = useAppContext();
  const commands = commandRegistry.resolve(appContext, layout);

  return (
    <>
      {COMMAND_GROUPS.map((group) => {
        const items = commands.filter((command) => command.render.group === group);
        if (items.length === 0) return null;
        return (
          <Fragment key={group}>
            <CommandGroup heading={group}>
              {items.map(({ id, render }) => (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => {
                    try {
                      render.run(actions);
                    } catch (error) {
                      console.error(`[contributions] "${id}" threw while running`, error);
                    }
                  }}
                >
                  <render.icon className="text-muted-foreground" />
                  {render.title}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </Fragment>
        );
      })}
    </>
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
