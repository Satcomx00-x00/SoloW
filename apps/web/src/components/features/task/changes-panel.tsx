"use client";

import type {
  ReviewDraftFile,
  ReviewNote,
  ScmFileDto,
  TaskDiffDto,
  TaskRepositoryDto,
} from "@solow/contracts";
import { primaryTaskRepository } from "@solow/core";
import { FileMinus, Lock, Scissors, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { scmFromCapturedDiff, splitPatchByFile } from "./captured-scm";
import { summariseDiff } from "./change-summary";
import { DiffEditor } from "./diff-editor";
import { EmptyPanel } from "./empty-panel";
import { describeTarget, groupChanges, type ReviewGroup } from "./review-groups";
import type { LineAnchor, ReviewNotes } from "./review-notes";
import { SourceControlPanel, type ViewedFiles } from "./source-control-panel";

/**
 * The Changes column (spec F22).
 *
 * The source-control panel over the change captured from the harness's last turn, with the
 * selected file's diff beneath it. Selecting a row shows that file without navigating away,
 * which is the whole reason the panel is a list of files rather than one long patch: on a change
 * touching thirty files, scrolling is not review.
 *
 * Read-only, and honestly so. These rows come from a record, not from a working tree — the live
 * path reads git through the orchestrator (Decision 0017) and is what makes staging possible.
 */

const CAPTURED_REASON = "Captured from the harness's last turn — read-only.";

/**
 * The reviewer's ticks, keyed across repositories (`draftFileKey` in `use-review-draft`).
 * Undefined means no review is being drafted — an older round, say — and no boxes are shown.
 */
export interface ReviewTicks {
  viewed: ReadonlySet<string>;
  onToggle: (file: ReviewDraftFile) => void;
  /** Every note in the draft, across files; the editor is handed the ones for its file. */
  notes: readonly ReviewNote[];
  onAddNote: (file: ReviewDraftFile, anchor: LineAnchor, text: string) => void;
  onEditNote: (note: ReviewNote, text: string) => void;
  onRemoveNote: (note: ReviewNote) => void;
}

function RepositoryChanges({
  diff,
  ticks,
}: {
  diff: TaskDiffDto;
  ticks?: ReviewTicks | undefined;
}) {
  const [view, setView] = useState<"tree" | "list">("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"split" | "inline">("split");

  const worktree = useMemo(() => scmFromCapturedDiff(diff, CAPTURED_REASON), [diff]);
  const sections = useMemo(
    () =>
      splitPatchByFile(
        diff.patch,
        diff.files.map((f) => f.path),
      ),
    [diff],
  );

  // The selected file's section, or the whole patch when nothing is selected — which is what the
  // panel showed before it had a file list, so the first view of a Task is unchanged.
  const patch = (selected && sections.get(selected)) || diff.patch;
  const noop = () => {};
  // The one file on screen, when there is one: a selected row, or a diff of a single file.
  const shownPath = selected ?? (diff.files.length === 1 ? (diff.files[0]?.path ?? null) : null);
  const repositoryId = diff.repositoryId ?? null;
  const notes = useMemo<ReviewNotes | undefined>(() => {
    if (!ticks || !shownPath) return undefined;
    const file = { repositoryId, path: shownPath };
    return {
      notes: ticks.notes.filter(
        (n) => n.path === shownPath && (n.repositoryId ?? null) === repositoryId,
      ),
      onAdd: (anchor, text) => ticks.onAddNote(file, anchor, text),
      onEdit: ticks.onEditNote,
      onRemove: ticks.onRemoveNote,
    };
  }, [ticks, shownPath, repositoryId]);
  const summary = useMemo(() => summariseDiff(diff), [diff]);
  // The panel speaks in paths; the draft keys files by repository as well, so a Task changing
  // `src/index.ts` in two repositories keeps two ticks. Translated at this seam, once.
  const viewedFiles = useMemo<ViewedFiles | undefined>(
    () =>
      ticks
        ? {
            viewed: new Set(
              diff.files
                .map((f) => f.path)
                .filter((path) => ticks.viewed.has(`${repositoryId ?? ""} ${path}`)),
            ),
            onToggleViewed: (path) => ticks.onToggle({ repositoryId, path }),
          }
        : undefined,
    [ticks, diff.files, repositoryId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ChangeStats summary={summary} />
      <div className="max-h-64 shrink-0">
        <SourceControlPanel
          worktree={worktree}
          view={view}
          onViewChange={setView}
          selectedPath={selected}
          onSelect={(file: ScmFileDto) =>
            setSelected((current) => (current === file.path ? null : file.path))
          }
          onStage={noop}
          onUnstage={noop}
          onDiscard={noop}
          onRefresh={noop}
          viewedFiles={viewedFiles}
        />
      </div>
      {patch && (
        <DiffEditor
          patch={patch}
          path={shownPath}
          mode={mode}
          onModeChange={setMode}
          notes={notes}
          // The editor's own footer says it only over the whole patch; a selected file's section
          // may or may not be the cut one. The flag above the list says it regardless.
          truncated={diff.truncated && patch === diff.patch}
        />
      )}
    </div>
  );
}

/**
 * How much, and what to look at first.
 *
 * "12 files · +340 −88" is the number a reviewer sizes the job by, and it was nowhere on the
 * page — the file list has a count, the rows have their own deltas, and adding them up was left
 * to the reader. Under it, the flags: each names a fact about the change that is easy to miss in
 * a long list and expensive to miss in review. Caution tone, not the failed red — nothing here
 * is wrong, it is *worth looking at*.
 *
 * The truncation flag lives here because the editor's own notice disappeared the moment a file
 * was selected (its `truncated` is only true over the whole patch), which is exactly when a
 * reviewer reading the cut-off file would need it.
 */
function ChangeStats({ summary }: { summary: ReturnType<typeof summariseDiff> }) {
  const flags: Array<{ key: string; icon: typeof Lock; text: string }> = [];
  if (summary.truncated) {
    flags.push({
      key: "truncated",
      icon: Scissors,
      text: "Patch cut short — the file list is complete, the diff is not. Check out the branch to read the rest.",
    });
  }
  if (summary.omitted.length > 0) {
    flags.push({
      key: "omitted",
      icon: Scissors,
      text: `${summary.omitted.length === 1 ? "1 generated file's body" : `${summary.omitted.length} generated files' bodies`} left out of the capture to keep it readable: ${summary.omitted.join(", ")}. Listed, not shown.`,
    });
  }
  if (summary.deleted.length > 0) {
    flags.push({
      key: "deleted",
      icon: FileMinus,
      text:
        summary.deleted.length === 1
          ? `Deletes ${summary.deleted[0]}`
          : `Deletes ${summary.deleted.length} files: ${summary.deleted.join(", ")}`,
    });
  }
  if (summary.lockfiles.length > 0) {
    flags.push({
      key: "lockfiles",
      icon: Lock,
      text: `Lockfile changed: ${summary.lockfiles.join(", ")}`,
    });
  }
  return (
    <div className="space-y-1" data-change-stats>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="font-medium">
          {summary.files} {summary.files === 1 ? "file" : "files"}
        </span>
        <span className="font-mono text-2xs">
          <span className="text-feedback-ok">+{summary.additions}</span>{" "}
          <span className="text-feedback-error">−{summary.deletions}</span>
        </span>
        {summary.generated.length > 0 ? (
          // The human share of the change, said next to the total: "+8 311" over a change whose
          // hand-written half is +1 838 is a number that misleads by an order of magnitude.
          <span className="text-2xs text-muted-foreground">
            · {summary.generated.length} generated ({summary.generatedLines} lines), folded
          </span>
        ) : null}
        <span className="text-2xs text-muted-foreground">· in reading order</span>
      </p>
      {flags.length > 0 ? (
        <ul className="space-y-0.5">
          {flags.map(({ key, icon: Icon, text }) => (
            <li
              key={key}
              className="flex items-start gap-1.5 text-2xs text-feedback-caution"
              data-change-flag={key}
            >
              <Icon aria-hidden className="mt-px size-3 shrink-0" />
              <span className="min-w-0 break-words">{text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One group's heading: which repository, which branch, and what approving it does (issue #70).
 *
 * The branch is in the heading rather than only inside the panel because the group *is*
 * `(repository, branch)` (AC-1) — two attachments of one repository land on two branches, and a
 * heading naming only the repository would be ambiguous exactly where it matters.
 *
 * The target sentence beneath it is AC-2: the consequence is stated before the decision, not
 * discovered after it.
 */
function GroupHeading({ group, captured }: { group: ReviewGroup; captured: boolean }) {
  return (
    <div className="mb-2 space-y-0.5">
      <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-medium text-sm">
        <span className="truncate">{group.repositoryName ?? "Unnamed repository"}</span>
        {group.branch && (
          <span className="truncate font-mono text-2xs text-muted-foreground">{group.branch}</span>
        )}
      </h2>
      <p className="text-2xs text-muted-foreground">{describeTarget(group, captured)}</p>
    </div>
  );
}

/**
 * The Changes column, grouped by `(repository, branch)` (spec F10 / issue #70, AC-1 and AC-2).
 *
 * Every group this approval covers is drawn, including a repository the harness never touched —
 * approving still records a branch for it, and a reviewer shown only the changed repositories
 * would be wrong about what they just approved. `groupChanges` decides what the groups are; this
 * only draws them.
 */
export function ChangesPanel({
  diffs,
  repositories = [],
  repositoryName,
  captured = true,
  ticks,
}: {
  diffs: TaskDiffDto[];
  /** The reviewer's viewed-ticks, when a review is being drafted against these diffs. */
  ticks?: ReviewTicks | undefined;
  /** The Task's attachments, so a repository with no diff is still a group. */
  repositories?: readonly TaskRepositoryDto[];
  /**
   * Whether the run has reached the point where a change is read at all.
   *
   * A change is captured once, at the review gate. Before that — and on a Task that has never
   * run — "no changes" is not a fact anyone has checked, and saying it while the harness is
   * visibly editing files is the panel contradicting the transcript beside it.
   */
  captured?: boolean;
  /** Names the attachments that produced no diff, which therefore carry no name of their own. */
  repositoryName?: ((repositoryId: string) => string | null) | undefined;
}) {
  const groups = useMemo(
    () => groupChanges(diffs, repositories, repositoryName),
    [diffs, repositories, repositoryName],
  );

  // Empty is said once, and says which empty: a change not read yet is not "no change", and a
  // run that changed nothing is not a panel waiting for something. Before this the summary row
  // ("0 files +0 −0"), each repository's shell and its "nothing changed" line all said it.
  const files = groups.reduce((n, g) => n + g.fileCount, 0);
  if (groups.length === 0 || files === 0) {
    return captured ? (
      <EmptyPanel
        label="The run changed no files."
        hint="There is nothing to read here — the plan and the brief are what the decision is about."
      />
    ) : (
      <EmptyPanel
        label="No change captured yet."
        hint="The harness's change is read once it reaches its review gate."
      />
    );
  }
  // One group is the ordinary case and gets no heading: naming the repository you are already
  // inside is noise, and this is the shape the panel had before Tasks spanned several.
  if (groups.length === 1 && groups[0]?.diff) {
    return <RepositoryChanges diff={groups[0].diff} ticks={ticks} />;
  }
  // A change outside the primary repository is the one thing a multi-repository approval most
  // often lands by surprise: the header names the primary's branch, the transcript is mostly
  // about it, and the second repository's diff is a scroll away. Said once, at the top.
  const primary = repositories.length > 0 ? primaryTaskRepository(repositories) : null;
  const secondaryChanged = groups.filter(
    (group) => group.diff !== null && group.repositoryId !== (primary?.repositoryId ?? null),
  );
  return (
    <div className="space-y-4">
      {primary && secondaryChanged.length > 0 ? (
        <p
          className="flex items-start gap-1.5 text-2xs text-feedback-caution"
          data-change-flag="secondary"
        >
          <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
          <span>
            Changes outside the primary repository:{" "}
            {secondaryChanged.map((g) => g.repositoryName ?? "an unnamed repository").join(", ")}.
          </span>
        </p>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.key}
          aria-label={`Changes in ${group.repositoryName ?? "an unnamed repository"}${
            group.branch ? ` on ${group.branch}` : ""
          }`}
        >
          <GroupHeading group={group} captured={captured} />
          {group.diff ? (
            <RepositoryChanges diff={group.diff} ticks={ticks} />
          ) : (
            // Said, not hidden. "Nothing changed here" is a consequence of the approval, and the
            // reviewer has to be able to see it without counting the groups — but only once it is
            // something anyone has checked. See `describeTarget`.
            <p className="surface-edge rounded-lg border bg-card px-3 py-2 text-2xs text-muted-foreground-subtle">
              {captured
                ? "The harness made no changes in this repository."
                : "No change has been read from this repository yet."}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
