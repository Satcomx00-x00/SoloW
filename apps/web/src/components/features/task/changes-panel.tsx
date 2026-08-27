"use client";

import type { ScmFileDto, TaskDiffDto, TaskRepositoryDto } from "@solow/contracts";
import { useMemo, useState } from "react";
import { scmFromCapturedDiff, splitPatchByFile } from "./captured-scm";
import { DiffEditor } from "./diff-editor";
import { describeTarget, groupChanges, type ReviewGroup } from "./review-groups";
import { SourceControlPanel } from "./source-control-panel";

/**
 * The Changes column (spec F22).
 *
 * The source-control panel over the change captured from the agent's last turn, with the
 * selected file's diff beneath it. Selecting a row shows that file without navigating away,
 * which is the whole reason the panel is a list of files rather than one long patch: on a change
 * touching thirty files, scrolling is not review.
 *
 * Read-only, and honestly so. These rows come from a record, not from a working tree — the live
 * path reads git through the orchestrator (Decision 0017) and is what makes staging possible.
 */

const CAPTURED_REASON = "Captured from the agent's last turn — read-only.";

function RepositoryChanges({ diff }: { diff: TaskDiffDto }) {
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
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
        />
      </div>
      {patch && (
        <DiffEditor
          patch={patch}
          path={selected ?? (diff.files.length === 1 ? (diff.files[0]?.path ?? null) : null)}
          mode={mode}
          onModeChange={setMode}
          truncated={diff.truncated && patch === diff.patch}
        />
      )}
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
 * Every group this approval covers is drawn, including a repository the agent never touched —
 * approving still records a branch for it, and a reviewer shown only the changed repositories
 * would be wrong about what they just approved. `groupChanges` decides what the groups are; this
 * only draws them.
 */
export function ChangesPanel({
  diffs,
  repositories = [],
  repositoryName,
  captured = true,
}: {
  diffs: TaskDiffDto[];
  /** The Task's attachments, so a repository with no diff is still a group. */
  repositories?: readonly TaskRepositoryDto[];
  /**
   * Whether the run has reached the point where a change is read at all.
   *
   * A change is captured once, at the review gate. Before that — and on a Task that has never
   * run — "no changes" is not a fact anyone has checked, and saying it while the agent is
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

  if (groups.length === 0) {
    return (
      <div className="surface-edge flex h-full min-h-40 items-center justify-center rounded-xl border bg-card text-muted-foreground/60 text-sm">
        No proposed changes yet.
      </div>
    );
  }
  // One group is the ordinary case and gets no heading: naming the repository you are already
  // inside is noise, and this is the shape the panel had before Tasks spanned several.
  if (groups.length === 1 && groups[0]?.diff) {
    return <RepositoryChanges diff={groups[0].diff} />;
  }
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-label={`Changes in ${group.repositoryName ?? "an unnamed repository"}${
            group.branch ? ` on ${group.branch}` : ""
          }`}
        >
          <GroupHeading group={group} captured={captured} />
          {group.diff ? (
            <RepositoryChanges diff={group.diff} />
          ) : (
            // Said, not hidden. "Nothing changed here" is a consequence of the approval, and the
            // reviewer has to be able to see it without counting the groups — but only once it is
            // something anyone has checked. See `describeTarget`.
            <p className="surface-edge rounded-lg border bg-card px-3 py-2 text-2xs text-muted-foreground/70">
              {captured
                ? "The agent made no changes in this repository."
                : "No change has been read from this repository yet."}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
