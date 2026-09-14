"use client";

import { Columns2, MessageSquarePlus, Rows3 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type LineAnchor, type ReviewNotes, ReviewNoteThread } from "./review-notes";
import { type DiffCell, type DiffLine, parseUnifiedDiff, toSideBySide } from "./unified-diff";

function anchorOf(line: DiffLine): LineAnchor | null {
  if (line.newLine !== null) return { side: "new", line: line.newLine };
  if (line.oldLine !== null) return { side: "old", line: line.oldLine };
  return null;
}

const anchorKey = (a: LineAnchor) => `${a.side}:${a.line}`;

/**
 * The diff editor (spec F22 FR-5).
 *
 * Not the patch. A patch is what git prints for another program: `diff --git`, `index`, `---`,
 * `+++`, `@@ -1,8 +1,8 @@` — five lines before the first line of code, none of which tells a
 * reader which line of the file changed. This shows the two files instead, aligned, numbered,
 * with the difference marked down to the characters that differ.
 *
 * Two modes, because both answer a real question: **split** shows what a line *was* next to what
 * it *became*, which is what a reviewer wants for a rewrite; **inline** reads as one file with
 * additions and removals in place, which is better for a change that is mostly insertions.
 */

/**
 * Row tints — the diff's own green/red, not a Task-state colour.
 *
 * Used to borrow `--state-done`/`--state-failed`, which is exactly what made this view lose its
 * colour the day Task lifecycle went monochrome. Green-and-red is the one convention every git
 * tool shares (that is the whole of "exactly like VS Code" in this file's own header comment),
 * so it gets tokens of its own that nothing about a Task's state can touch again.
 */
const CELL_TONE = {
  deleted: "bg-diff-removed/10",
  added: "bg-diff-added/10",
  context: "",
} as const;

const MARK_TONE = {
  deleted: "bg-diff-removed/25",
  added: "bg-diff-added/25",
} as const;

/** A line's text with the characters that actually changed marked inside it. */
function CellText({ cell, tone }: { cell: DiffCell; tone: "deleted" | "added" | "context" }) {
  if (cell.text === null) return null;
  const mark = tone === "context" ? null : cell.highlight;
  return (
    <span className="whitespace-pre">
      {mark ? (
        <>
          {cell.text.slice(0, mark.start)}
          <span className={cn("rounded-[2px]", MARK_TONE[tone as "deleted" | "added"])}>
            {cell.text.slice(mark.start, mark.end)}
          </span>
          {cell.text.slice(mark.end)}
        </>
      ) : (
        cell.text || " "
      )}
      {cell.noNewline && (
        <span
          className="ml-2 select-none text-2xs text-muted-foreground/50"
          title="No newline at end of file"
        >
          ↵
        </span>
      )}
    </span>
  );
}

function Gutter({ line }: { line: number | null }) {
  return (
    <span
      aria-hidden
      className="w-10 shrink-0 select-none pr-2 text-right font-mono text-2xs text-muted-foreground/45 tabular-nums"
    >
      {line ?? ""}
    </span>
  );
}

/**
 * The "+" that appears on a row under the pointer when notes are being taken — GitHub's gesture,
 * because that is where every reviewer learned it. Absent entirely when the editor is read-only.
 */
function NoteButton({ anchor, onClick }: { anchor: LineAnchor; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={
        anchor.side === "old"
          ? `Add a note on old line ${anchor.line}`
          : `Add a note on line ${anchor.line}`
      }
      onClick={onClick}
      className="-ml-1 mr-1 inline-flex size-4 shrink-0 items-center justify-center self-center rounded bg-primary text-primary-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/line:opacity-100"
    >
      <MessageSquarePlus aria-hidden className="size-3" />
    </button>
  );
}

/**
 * What hangs under a row: the notes already on it, and the form when one is being written.
 * Rendered by both layouts so the two never disagree about where a note lives.
 */
function UnderRow({
  anchor,
  notes,
  composing,
  onCompose,
}: {
  anchor: LineAnchor | null;
  notes: ReviewNotes | undefined;
  composing: string | null;
  onCompose: (key: string | null) => void;
}) {
  if (!anchor || !notes) return null;
  const key = anchorKey(anchor);
  const here = notes.notes.filter((n) => n.side === anchor.side && n.line === anchor.line);
  if (here.length === 0 && composing !== key) return null;
  return (
    <ReviewNoteThread
      anchor={anchor}
      notes={here}
      composing={composing === key}
      onCompose={(open) => onCompose(open ? key : null)}
      onSave={(text) => notes.onAdd(anchor, text)}
      onEdit={(note, text) => notes.onEdit(note, text)}
      onRemove={(note) => notes.onRemove(note)}
    />
  );
}

/** The `@@` header, shown as the separator it is rather than as its own syntax. */
function HunkSeparator({ heading }: { heading: string }) {
  return (
    <div className="flex items-center gap-2 border-y bg-background/50 px-2 py-1">
      <span aria-hidden className="h-px flex-1 bg-border" />
      {heading && (
        <span className="truncate font-mono text-2xs text-muted-foreground-subtle">{heading}</span>
      )}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

interface RowsProps {
  lines: DiffLine[];
  notes: ReviewNotes | undefined;
  composing: string | null;
  onCompose: (key: string | null) => void;
}

function SplitRows({ lines, notes, composing, onCompose }: RowsProps) {
  const rows = useMemo(() => toSideBySide(lines), [lines]);
  return (
    <>
      {rows.map((row, index) => {
        const leftTone =
          row.kind === "context" ? "context" : row.left.text === null ? "context" : "deleted";
        const rightTone =
          row.kind === "context" ? "context" : row.right.text === null ? "context" : "added";
        // The new side when the row has one; a pure deletion anchors on the old.
        const anchor: LineAnchor | null =
          row.right.line !== null
            ? { side: "new", line: row.right.line }
            : row.left.line !== null
              ? { side: "old", line: row.left.line }
              : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff row is positional — it has no identity beyond where it sits, and the list is never reordered or spliced.
          <div key={index}>
            <div className="group/line flex font-mono text-xs leading-[1.55]">
              <div className={cn("flex min-w-0 flex-1 basis-0", CELL_TONE[leftTone])}>
                <Gutter line={row.left.line} />
                <span className="min-w-0 flex-1 overflow-hidden pr-2">
                  <CellText cell={row.left} tone={leftTone} />
                </span>
              </div>
              <div aria-hidden className="w-px shrink-0 bg-border" />
              <div className={cn("flex min-w-0 flex-1 basis-0", CELL_TONE[rightTone])}>
                <Gutter line={row.right.line} />
                {notes && anchor ? (
                  <NoteButton anchor={anchor} onClick={() => onCompose(anchorKey(anchor))} />
                ) : null}
                <span className="min-w-0 flex-1 overflow-hidden pr-2">
                  <CellText cell={row.right} tone={rightTone} />
                </span>
              </div>
            </div>
            <UnderRow anchor={anchor} notes={notes} composing={composing} onCompose={onCompose} />
          </div>
        );
      })}
    </>
  );
}

function InlineRows({ lines, notes, composing, onCompose }: RowsProps) {
  return (
    <>
      {lines.map((line, index) => {
        const tone = line.kind === "context" ? "context" : line.kind;
        const anchor = anchorOf(line);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff row is positional — it has no identity beyond where it sits, and the list is never reordered or spliced.
          <div key={index}>
            <div
              className={cn("group/line flex font-mono text-xs leading-[1.55]", CELL_TONE[tone])}
            >
              <Gutter line={line.oldLine} />
              <Gutter line={line.newLine} />
              {notes && anchor ? (
                <NoteButton anchor={anchor} onClick={() => onCompose(anchorKey(anchor))} />
              ) : null}
              <span
                aria-hidden
                className={cn(
                  "w-3 shrink-0 select-none text-center",
                  line.kind === "added" && "text-diff-added",
                  line.kind === "deleted" && "text-diff-removed",
                )}
              >
                {line.kind === "added" ? "+" : line.kind === "deleted" ? "-" : ""}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden whitespace-pre pr-2">
                {line.text || " "}
                {line.noNewline && (
                  <span className="ml-2 select-none text-2xs text-muted-foreground/50">↵</span>
                )}
              </span>
            </div>
            <UnderRow anchor={anchor} notes={notes} composing={composing} onCompose={onCompose} />
          </div>
        );
      })}
    </>
  );
}

export function DiffEditor({
  patch,
  path,
  mode,
  onModeChange,
  truncated = false,
  notes,
}: {
  patch: string;
  path: string | null;
  mode: "split" | "inline";
  onModeChange: (mode: "split" | "inline") => void;
  truncated?: boolean;
  /**
   * The reviewer's notes on this file, and the means to take more (spec F10 FR-7). Only when the
   * editor is showing one file of the round under review — a whole-patch view has no single
   * path to anchor on, and an older round is read, not reviewed.
   */
  notes?: ReviewNotes | undefined;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const title = path ?? parsed.path;
  // Which row has its note form open — one at a time, keyed `side:line`.
  const [composing, setComposing] = useState<string | null>(null);

  return (
    <section
      aria-label={title ? `Diff for ${title}` : "Diff"}
      className="surface-edge flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span
          className="min-w-0 truncate font-mono text-2xs text-muted-foreground"
          title={title ?? ""}
        >
          {title ?? "Diff"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-6"
          aria-label={mode === "split" ? "Show inline diff" : "Show side-by-side diff"}
          aria-pressed={mode === "split"}
          onClick={() => onModeChange(mode === "split" ? "inline" : "split")}
        >
          {mode === "split" ? (
            <Rows3 aria-hidden className="size-3.5" />
          ) : (
            <Columns2 aria-hidden className="size-3.5" />
          )}
        </Button>
      </div>

      {parsed.empty ? (
        <p className="px-3 py-4 text-muted-foreground text-sm">
          {/* A binary file or a pure rename: real changes with no lines to show. */}
          No line changes to show for this file.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {parsed.hunks.map((hunk, index) => (
            // A hunk's start lines are its identity within one file — but the whole-patch view
            // shows several files, and five new one-line files all begin `@@ -0,0 +1 @@`. The
            // position disambiguates; the list is never reordered or spliced.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div key={`${index}:${hunk.oldStart}:${hunk.newStart}`}>
              {index > 0 || hunk.heading ? <HunkSeparator heading={hunk.heading} /> : null}
              {mode === "split" ? (
                <SplitRows
                  lines={hunk.lines}
                  notes={notes}
                  composing={composing}
                  onCompose={setComposing}
                />
              ) : (
                <InlineRows
                  lines={hunk.lines}
                  notes={notes}
                  composing={composing}
                  onCompose={setComposing}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {truncated && (
        <p className="shrink-0 border-t px-3 py-1.5 text-2xs text-muted-foreground">
          This diff was cut short. The file list above is complete; check out the branch to read the
          rest.
        </p>
      )}
    </section>
  );
}
