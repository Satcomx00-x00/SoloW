"use client";

import type { ScmFileDto, TaskDiffDto } from "@gatecontrol/contracts";
import { useMemo, useState } from "react";
import { scmFromCapturedDiff, splitPatchByFile } from "./captured-scm";
import { DiffEditor } from "./diff-editor";
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

export function ChangesPanel({ diffs }: { diffs: TaskDiffDto[] }) {
  if (diffs.length === 0) {
    return (
      <div className="surface-edge flex h-full min-h-40 items-center justify-center rounded-xl border bg-card text-muted-foreground/60 text-sm">
        No proposed changes yet.
      </div>
    );
  }
  if (diffs.length === 1 && diffs[0]) {
    return <RepositoryChanges diff={diffs[0]} />;
  }
  return (
    <div className="space-y-4">
      {diffs.map((diff, index) => (
        <section
          key={diff.repositoryId ?? diff.diffRef ?? index}
          aria-label={`Changes in ${diff.repositoryName ?? diff.diffRef}`}
        >
          {/* The repository's name is the group's heading; the panel below carries the branch. */}
          <h2 className="mb-2 truncate font-medium text-sm">
            {diff.repositoryName ?? "Unnamed repository"}
          </h2>
          <RepositoryChanges diff={diff} />
        </section>
      ))}
    </div>
  );
}
