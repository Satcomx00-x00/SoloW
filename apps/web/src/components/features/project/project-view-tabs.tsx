"use client";

import type { ProjectViewDto } from "@solow/contracts";
import { ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The tab strip (spec F23 FR-9, issue #129).
 *
 * `Prioritized backlog · Status board · Roadmap · Bugs · In review · My items · + New view` —
 * one project, several questions asked of it. A tab is a saved configuration and nothing more,
 * so switching one costs a re-render and never a re-fetch of the rows.
 *
 * Reordering is two menu items rather than a drag: the strip is small, and left/right work from
 * a keyboard, which a drag does not. The whole order is sent on every move (`onReorder`), which
 * is what stops two people rearranging tabs from interleaving into an order neither chose.
 *
 * On the app's Tabs primitive rather than a row of buttons wearing `role="tab"`: the arrows,
 * the sliding underline and the scroll-with-fades come with it, and the rows below are not a
 * panel of the strip — a view is a saved question, and the table answers whichever is asked.
 */
/**
 * The strip with one tab moved a single place.
 *
 * A swap rather than a splice-and-insert, and the *whole* order is what comes back: moving a tab
 * must not be able to produce a list that drops or repeats an id, because that list is written
 * straight to every tab's position. An impossible move returns the order untouched.
 */
export function moveInOrder(order: readonly string[], viewId: string, by: -1 | 1): string[] {
  const from = order.indexOf(viewId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to] as string, next[from] as string];
  return next;
}

export function ProjectViewTabs({
  views,
  activeViewId,
  onSelect,
  onCreate,
  onRename,
  onReorder,
  onDelete,
  disabled = false,
}: {
  views: readonly ProjectViewDto[];
  activeViewId: string | null;
  onSelect: (viewId: string) => void;
  /** Create a tab holding whatever is on screen — a filter someone just typed is worth keeping. */
  onCreate: () => void;
  onRename: (viewId: string, name: string) => void;
  onReorder: (viewIds: string[]) => void;
  onDelete: (viewId: string) => void;
  disabled?: boolean;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);

  const move = (viewId: string, by: -1 | 1) =>
    onReorder(
      moveInOrder(
        views.map((v) => v.id),
        viewId,
        by,
      ),
    );

  return (
    <Tabs value={activeViewId ?? ""} onValueChange={onSelect} className="shrink-0 gap-0">
      <TabsList variant="line" aria-label="Views" className="w-full border-b px-4">
        {views.map((view, index) => {
          const active = view.id === activeViewId;
          if (renaming === view.id) {
            return (
              <form
                key={view.id}
                className="py-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = new FormData(event.currentTarget).get("name");
                  setRenaming(null);
                  if (typeof name === "string" && name.trim() !== "")
                    onRename(view.id, name.trim());
                }}
              >
                <input
                  name="name"
                  aria-label={`Rename ${view.name}`}
                  defaultValue={view.name}
                  // Focused and selected on mount, so renaming is type-over rather than
                  // click-into. A ref rather than `autoFocus`, which steals focus on any render
                  // the browser decides to give it.
                  ref={(node) => node?.select()}
                  maxLength={60}
                  // Blur commits nothing: leaving the field is how people abandon a rename, and a
                  // half-typed tab name saved on the way past is a tab nobody meant to create.
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRenaming(null);
                  }}
                  className="h-6 w-32 rounded border bg-transparent px-1.5 text-xs"
                />
              </form>
            );
          }

          return (
            <span key={view.id} className="flex shrink-0 items-center">
              <TabsTrigger value={view.id} disabled={disabled} className="text-xs">
                {view.name}
              </TabsTrigger>
              {active && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-xs" variant="ghost" aria-label={`${view.name} view options`}>
                      <MoreHorizontal aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => setRenaming(view.id)}>
                      <Pencil aria-hidden /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={index === 0} onSelect={() => move(view.id, -1)}>
                      <ChevronLeft aria-hidden /> Move left
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={index === views.length - 1}
                      onSelect={() => move(view.id, 1)}
                    >
                      <ChevronRight aria-hidden /> Move right
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => onDelete(view.id)}
                    >
                      {/* Deleting a view deletes a question, never the rows it selected. */}
                      <Trash2 aria-hidden /> Delete view
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </span>
          );
        })}

        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={onCreate}
          className="shrink-0"
        >
          <Plus aria-hidden /> New view
        </Button>
      </TabsList>
    </Tabs>
  );
}
