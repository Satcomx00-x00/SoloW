"use client";

import type { ScmFileDto, ScmGroup, ScmWorktreeDto } from "@gatecontrol/contracts";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  ListTree,
  Minus,
  Plus,
  RefreshCw,
  Rows3,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildScmTree, type ScmTreeNode, splitPath } from "./source-control-tree";

/**
 * The source-control panel (spec F22).
 *
 * Deliberately the surface a developer already has in their editor — the same four groups, the
 * same status letters, the same place to click. What differs is what staging *means*: it is the
 * review selection, and approval commits exactly what is staged (FR-7). There is no commit
 * button here, and its absence is the design, not an omission.
 *
 * Presentational on purpose. It renders the status the orchestrator read and calls back with
 * paths; it never decides whether a write is allowed, because that answer depends on whether an
 * agent is running and a browser can only know that one turn late (`writable` on the DTO).
 */

const GROUP_ORDER: ScmGroup[] = ["merge", "staged", "changes", "untracked"];

const GROUP_LABEL: Record<ScmGroup, string> = {
  merge: "Merge Changes",
  staged: "Staged Changes",
  changes: "Changes",
  untracked: "Untracked",
};

/** The letter's colour says the same thing the letter does, for anyone scanning rather than reading. */
const LETTER_TONE: Record<string, string> = {
  A: "text-diff-added",
  "?": "text-diff-added",
  M: "text-state-running",
  R: "text-state-parked",
  C: "text-state-parked",
  D: "text-diff-removed",
  U: "text-diff-removed",
};

export interface SourceControlActions {
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onRefresh: () => void;
}

interface RowActionsProps extends SourceControlActions {
  group: ScmGroup;
  paths: string[];
  /** A group header's actions read "all"; a row's name the file. */
  scope: string;
}

/**
 * Which verbs a group offers.
 *
 * A conflict offers none: staging one half of an unresolved merge records a decision nobody
 * made, and this panel shows conflicts rather than pretending to resolve them.
 */
function RowActions({ group, paths, scope, onStage, onUnstage, onDiscard }: RowActionsProps) {
  if (group === "merge" || paths.length === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
      {group !== "staged" && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Discard ${scope}`}
          onClick={() => onDiscard(paths)}
        >
          <Undo2 aria-hidden className="size-3.5" />
        </Button>
      )}
      {group === "staged" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Unstage ${scope}`}
          onClick={() => onUnstage(paths)}
        >
          <Minus aria-hidden className="size-3.5" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Stage ${scope}`}
          onClick={() => onStage(paths)}
        >
          <Plus aria-hidden className="size-3.5" />
        </Button>
      )}
    </span>
  );
}

function FileRow({
  file,
  label,
  parent,
  depth,
  selected,
  writable,
  onSelect,
  actions,
}: {
  file: ScmFileDto;
  label: string;
  parent: string;
  depth: number;
  selected: boolean;
  writable: boolean;
  onSelect: (file: ScmFileDto) => void;
  actions: SourceControlActions;
}) {
  return (
    <li className="group/row">
      <div
        className={cn(
          "flex items-center gap-2 py-1 pr-1.5 text-xs",
          selected && "bg-accent/60",
          !selected && "hover:bg-accent/30",
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <button
          type="button"
          onClick={() => onSelect(file)}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            aria-hidden
            className={cn("w-3 shrink-0 text-center font-mono", LETTER_TONE[file.letter])}
          >
            {file.letter}
          </span>
          <span className="min-w-0 truncate" title={file.path}>
            {label}
            {parent && <span className="ml-1.5 text-muted-foreground/60">{parent}</span>}
          </span>
          {/* The letter is meaning; screen readers get it in words rather than as a glyph. */}
          <span className="sr-only">{` ${file.kind}`}</span>
        </button>
        {!file.binary && (file.additions !== null || file.deletions !== null) && (
          <span className="shrink-0 font-mono text-2xs tabular-nums">
            {file.additions ? <span className="text-diff-added">+{file.additions}</span> : null}
            {file.deletions ? (
              <span className="ml-1 text-diff-removed">-{file.deletions}</span>
            ) : null}
          </span>
        )}
        {file.binary && <span className="shrink-0 text-2xs text-muted-foreground/60">binary</span>}
        {writable && (
          <RowActions
            group={file.group}
            paths={[file.path]}
            scope={label}
            {...actions}
            onRefresh={actions.onRefresh}
          />
        )}
      </div>
    </li>
  );
}

function TreeNodes({
  nodes,
  depth,
  selectedPath,
  writable,
  onSelect,
  actions,
}: {
  nodes: ScmTreeNode[];
  depth: number;
  selectedPath: string | null;
  writable: boolean;
  onSelect: (file: ScmFileDto) => void;
  actions: SourceControlActions;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "directory" ? (
          <li key={node.path}>
            <div
              className="flex items-center gap-1.5 py-1 text-2xs text-muted-foreground"
              style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
            >
              <ChevronDown aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{node.label}</span>
            </div>
            <ul>
              <TreeNodes
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                writable={writable}
                onSelect={onSelect}
                actions={actions}
              />
            </ul>
          </li>
        ) : (
          <FileRow
            key={node.path}
            file={node.file}
            label={splitPath(node.path).name}
            parent=""
            depth={depth}
            selected={node.path === selectedPath}
            writable={writable}
            onSelect={onSelect}
            actions={actions}
          />
        ),
      )}
    </>
  );
}

/** What a discard is about to do, in the words that apply to these particular files. */
function discardCopy(files: ScmFileDto[]): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  const untracked = files.filter((f) => f.group === "untracked");
  const tracked = files.length - untracked.length;
  const noun = files.length === 1 ? "file" : "files";
  // "Discard" reads as "revert". For an untracked file it means delete, and there is no commit
  // to bring it back from — so the confirmation says the word that is true.
  const description =
    untracked.length > 0 && tracked === 0
      ? `${untracked.length} untracked ${noun} will be deleted from the worktree. There is no commit to restore ${files.length === 1 ? "it" : "them"} from.`
      : untracked.length === 0
        ? `${tracked} ${noun} will be reverted to the last commit. Any change the agent made ${files.length === 1 ? "to it" : "to them"} is lost.`
        : `${tracked} tracked ${noun === "file" ? "file" : "files"} will be reverted to the last commit and ${untracked.length} untracked will be deleted.`;
  return {
    title: `Discard ${files.length} ${noun}?`,
    description: `${description} This cannot be undone from here.`,
    confirmLabel: "Discard",
  };
}

export function SourceControlPanel({
  worktree,
  view,
  onViewChange,
  selectedPath,
  onSelect,
  busy = false,
  ...actions
}: SourceControlActions & {
  worktree: ScmWorktreeDto;
  view: "tree" | "list";
  onViewChange: (view: "tree" | "list") => void;
  selectedPath: string | null;
  onSelect: (file: ScmFileDto) => void;
  busy?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Partial<Record<ScmGroup, boolean>>>({});
  const [pendingDiscard, setPendingDiscard] = useState<ScmFileDto[] | null>(null);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    files: worktree.files.filter((f) => f.group === group),
  })).filter((entry) => entry.files.length > 0);

  const confirmDiscard = (paths: string[]) => {
    const files = worktree.files.filter((f) => paths.includes(f.path));
    setPendingDiscard(files.length > 0 ? files : null);
  };
  const copy = pendingDiscard ? discardCopy(pendingDiscard) : null;
  const rowActions: SourceControlActions = { ...actions, onDiscard: confirmDiscard };

  return (
    <div className="surface-edge flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {worktree.branch.detached ? "detached HEAD" : (worktree.branch.name ?? "no branch")}
          </span>
        </span>
        {worktree.branch.upstream && (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
            {worktree.branch.upstream}
            {worktree.branch.ahead > 0 && ` ↑${worktree.branch.ahead}`}
            {worktree.branch.behind > 0 && ` ↓${worktree.branch.behind}`}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <span className="mr-1 font-mono text-2xs text-muted-foreground tabular-nums">
            {worktree.total}
            {/* The badge is a bare number to the eye; a reader needs the noun with it. */}
            <span className="sr-only"> changed files</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={view === "tree" ? "Show as list" : "Show as tree"}
            onClick={() => onViewChange(view === "tree" ? "list" : "tree")}
          >
            {view === "tree" ? (
              <Rows3 aria-hidden className="size-3.5" />
            ) : (
              <ListTree aria-hidden className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Refresh source control"
            disabled={busy}
            onClick={actions.onRefresh}
          >
            <RefreshCw aria-hidden className={cn("size-3.5", busy && "animate-spin")} />
          </Button>
        </span>
      </div>

      {!worktree.writable && worktree.readOnlyReason && (
        // Said in place of the actions rather than as disabled buttons with no explanation.
        <p className="shrink-0 border-b bg-background/60 px-3 py-1.5 text-2xs text-muted-foreground">
          {worktree.readOnlyReason}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="px-3 py-4 text-muted-foreground text-sm">
          Nothing has changed in this worktree yet.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map(({ group, files }) => {
            const open = !collapsed[group];
            const paths = files.map((f) => f.path);
            return (
              <section key={group} className="group/row">
                <div className="flex items-center gap-1.5 border-b bg-background/40 px-2 py-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setCollapsed((c) => ({ ...c, [group]: open }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium text-2xs uppercase tracking-wide"
                  >
                    {open ? (
                      <ChevronDown aria-hidden className="size-3 shrink-0" />
                    ) : (
                      <ChevronRight aria-hidden className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{GROUP_LABEL[group]}</span>
                    <span className="ml-1 font-mono text-muted-foreground tabular-nums">
                      {files.length}
                    </span>
                  </button>
                  {worktree.writable && (
                    <RowActions
                      group={group}
                      paths={paths}
                      scope={`all in ${GROUP_LABEL[group]}`}
                      {...rowActions}
                    />
                  )}
                </div>
                {open && (
                  <ul aria-label={GROUP_LABEL[group]}>
                    {view === "tree" ? (
                      <TreeNodes
                        nodes={buildScmTree(files)}
                        depth={0}
                        selectedPath={selectedPath}
                        writable={worktree.writable}
                        onSelect={onSelect}
                        actions={rowActions}
                      />
                    ) : (
                      files.map((file) => {
                        const { name, parent } = splitPath(file.path);
                        return (
                          <FileRow
                            key={`${file.group}:${file.path}`}
                            file={file}
                            label={name}
                            parent={parent}
                            depth={0}
                            selected={file.path === selectedPath}
                            writable={worktree.writable}
                            onSelect={onSelect}
                            actions={rowActions}
                          />
                        );
                      })
                    )}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {worktree.truncated && (
        <p className="shrink-0 border-t px-3 py-1.5 text-2xs text-muted-foreground">
          Showing {worktree.files.length} of {worktree.total} changed files.
        </p>
      )}

      {copy && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDiscard(null);
          }}
          onConfirm={() => {
            const paths = (pendingDiscard ?? []).map((f) => f.path);
            setPendingDiscard(null);
            actions.onDiscard(paths);
          }}
          {...copy}
        />
      )}
    </div>
  );
}
