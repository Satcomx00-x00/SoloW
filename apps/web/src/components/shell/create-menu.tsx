"use client";

import { ChevronDown, Download, FolderPlus, Plus, SquarePen, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type CreateKind, onOpenCreateDialog } from "@/components/features/board/create-dialog-bus";
import { CreateTaskDialog } from "@/components/features/board/create-task-dialog";
import { ConnectRepositoryDialog } from "@/components/features/issues/connect-repository-dialog";
import { ImportIssuesDialog } from "@/components/features/issues/import-issues-dialog";
import { IssueFormDialog } from "@/components/features/issues/issue-form-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/trpc/react";

/**
 * Every way to create or import work, in one place in the shell header (user report: "la gestion
 * et l'importation des issues depuis les intégrations GitHub et GitLab sont réparties à plusieurs
 * endroits").
 *
 * They were spread across five surfaces before this — the board's own header, the Issues page's
 * own header, two glyph buttons inside the Backlog column, Settings → Integrations, and the
 * command palette — so which ones you could reach depended on where you happened to be standing.
 * The app is a single-page shell with a persistent header, so the header is the one surface
 * every route already shares.
 *
 * This component owns the four dialogs rather than merely linking to them. That is what makes
 * them route-independent: previously "New task" lived on the board, so the command palette had
 * to `router.push("/board")` before it could ask for the dialog at all.
 */

/** Whether the shortcut modifier for this platform is pressed — ⌘ on Mac, Ctrl elsewhere. */
function hasModifier(event: KeyboardEvent): boolean {
  return navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
}

export function CreateMenu() {
  const [dialog, setDialog] = useState<CreateKind | null>(null);
  const utils = trpc.useUtils();

  const close = useCallback(() => setDialog(null), []);

  // The bus is the one entry point, so the command palette, the keyboard shortcuts below and the
  // menu items all arrive the same way and cannot drift apart.
  useEffect(() => {
    const kinds: CreateKind[] = ["task", "issue", "import-issues", "connect-repository"];
    const unsubscribes = kinds.map((kind) => onOpenCreateDialog(kind, () => setDialog(kind)));
    return () => {
      for (const off of unsubscribes) off();
    };
  }, []);

  /**
   * ⌘⇧T / ⌘⇧I, the two shortcuts the menu advertises.
   *
   * Bound on the shell rather than inside each dialog, because the point of them is to work when
   * no dialog is open. A keystroke while focus is in a text field is left alone: ⇧ plus a letter
   * is something a person types.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hasModifier(event) || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "i") return;
      event.preventDefault();
      setDialog(key === "t" ? "task" : "issue");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" className="h-8 gap-1.5">
            <Plus />
            Create
            <ChevronDown className="size-3.5 opacity-70" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Create</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setDialog("task")}>
            <Zap />
            New task
            <DropdownMenuShortcut>⌘⇧T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("issue")}>
            <SquarePen />
            New issue
            <DropdownMenuShortcut>⌘⇧I</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>From an integration</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setDialog("import-issues")}>
            <Download />
            Import issues…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("connect-repository")}>
            <FolderPlus />
            Connect a repository…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Mounted only while open, and keyed by nothing else: each of these holds form state that
        should start empty every time, and unmounting on close is the cheapest way to guarantee
        that without a reset path in four separate components.
      */}
      {dialog === "task" && (
        <CreateTaskDialog trigger={null} open onOpenChange={(next) => !next && close()} />
      )}
      {dialog === "issue" && (
        <IssueFormDialog
          open
          onOpenChange={(next) => !next && close()}
          onSuccess={() => utils.issue.list.invalidate()}
        />
      )}
      {dialog === "import-issues" && (
        <ImportIssuesDialog trigger={null} open onOpenChange={(next) => !next && close()} />
      )}
      {dialog === "connect-repository" && (
        <ConnectRepositoryDialog open onOpenChange={(next) => !next && close()} />
      )}
    </>
  );
}
