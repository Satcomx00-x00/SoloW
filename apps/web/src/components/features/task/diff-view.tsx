"use client";

import type { DiffFileDto, TaskDiffDto } from "@gatecontrol/contracts";
import { FileMinus2, FilePen, FilePlus2, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The change an agent is proposing, file by file (task TASK-022).
 *
 * Until now the Changes tab named the branch and stopped there, which asked a reviewer to
 * approve work they could not see. Approving is the one irreversible step in the loop
 * (Principle I), so the thing being approved has to be legible without leaving the app.
 *
 * The file list comes first and is always complete: it is what tells you the shape of the change
 * — three files or thirty, and which ones — before you read a single line. The patch below it is
 * bounded, and says so when it has been cut.
 */

const STATUS_STYLE: Record<DiffFileDto["status"], { icon: typeof FilePen; tone: string }> = {
  added: { icon: FilePlus2, tone: "text-state-done" },
  modified: { icon: FilePen, tone: "text-state-running" },
  deleted: { icon: FileMinus2, tone: "text-state-failed" },
  renamed: { icon: FilePen, tone: "text-state-parked" },
};

/** A line's role in the patch, from its first character. */
function lineTone(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground/60";
  if (line.startsWith("@@")) return "text-state-parked";
  if (line.startsWith("+")) return "text-state-done";
  if (line.startsWith("-")) return "text-state-failed";
  if (line.startsWith("diff --git")) return "text-muted-foreground font-medium";
  return "text-foreground/70";
}

function FileRow({ file }: { file: DiffFileDto }) {
  const { icon: Icon, tone } = STATUS_STYLE[file.status];
  return (
    <li className="flex items-center gap-2.5 px-3 py-1.5">
      <Icon aria-hidden strokeWidth={2} className={cn("size-3.5 shrink-0", tone)} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 font-mono text-2xs tabular-nums">
        {file.additions > 0 && <span className="text-state-done">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && " "}
        {file.deletions > 0 && <span className="text-state-failed">-{file.deletions}</span>}
        {file.additions === 0 && file.deletions === 0 && (
          <span className="text-muted-foreground/60">0</span>
        )}
      </span>
    </li>
  );
}

export function DiffView({ diff, branch }: { diff: TaskDiffDto | null; branch: string | null }) {
  if (!diff) {
    return (
      <div className="surface-edge h-full rounded-xl border bg-card p-5">
        {branch ? (
          <div className="space-y-2">
            <p className="font-medium text-sm">Proposed on a new branch</p>
            <p className="inline-flex items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5 font-mono text-xs">
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {branch}
            </p>
            {/* Honest about why: a missing diff is a capture that failed, not an empty change. */}
            <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
              The file-level diff was not captured for this run. The change itself is intact on the
              branch above.
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground/60">
            No proposed changes yet.
          </div>
        )}
      </div>
    );
  }

  const additions = diff.files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = diff.files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="surface-edge shrink-0 overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{diff.diffRef}</span>
          </span>
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums">
            <span className="text-muted-foreground">
              {diff.files.length === 1 ? "1 file" : `${diff.files.length} files`}
            </span>
            {additions > 0 && <span className="ml-2 text-state-done">+{additions}</span>}
            {deletions > 0 && <span className="ml-2 text-state-failed">-{deletions}</span>}
          </span>
        </div>
        {diff.files.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground text-sm">
            The agent finished without changing any files.
          </p>
        ) : (
          <ul aria-label="Changed files" className="max-h-56 divide-y overflow-y-auto">
            {diff.files.map((file) => (
              <FileRow key={file.path} file={file} />
            ))}
          </ul>
        )}
      </div>

      {diff.patch && (
        <div className="surface-edge flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-[oklch(0.13_0.008_265)]">
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-[1.6]">
            {diff.patch.split("\n").map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a patch is positional text whose lines carry no identity of their own, and this renders an immutable string that is never reordered or spliced.
              <div key={index} className={cn("whitespace-pre", lineTone(line))}>
                {line || " "}
              </div>
            ))}
          </pre>
          {diff.truncated && (
            <p className="shrink-0 border-t bg-card px-3 py-1.5 text-2xs text-muted-foreground">
              Patch truncated. The file list above is complete; check out the branch to read the
              rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
