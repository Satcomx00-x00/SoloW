"use client";

import type { presentFilesWidget } from "@gatecontrol/contracts";
import type { z } from "zod";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

type PresentFilesWidget = z.infer<typeof presentFilesWidget>;

/**
 * Files the agent wants looked at (`present_files`).
 *
 * Paths and annotations, never contents — the contract refuses a file body, and the Changes tab
 * is where a diff belongs. What this adds is the agent's own pointing: "these six of the forty
 * files I touched are the ones to read", which nothing else in the transcript can say.
 */
export function PresentFiles({ widget }: WidgetRendererProps<PresentFilesWidget>) {
  return (
    <section
      data-widget="present_files"
      aria-label={widget.title ?? "Files"}
      className="min-w-0 space-y-1.5 rounded-xl border bg-card/60 p-3"
    >
      {widget.title && <h3 className="font-medium text-sm">{widget.title}</h3>}
      <ul className="space-y-1">
        {widget.files.map((file) => (
          <li key={file.path} className="flex items-baseline gap-2 text-xs">
            {file.status && (
              <span
                className={cn(
                  "w-14 shrink-0 text-2xs uppercase tracking-wide",
                  STATUS_TONE[file.status],
                )}
              >
                {file.status}
              </span>
            )}
            {/* `dir` on a path so a long one truncates at the *front*: the filename is what
                identifies it, and "…/features/task/widgets/present-files.tsx" is readable where
                "apps/web/src/components/fea…" is not. */}
            <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono">
              {file.path}
            </span>
            {file.note && <span className="shrink-0 text-muted-foreground">{file.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `added`/`deleted` get the diff editor's own green/red, not a Task-state colour — a file's status
 * here is the same fact the Changes tab's file list shows (`diff-view.tsx`), and the two must
 * agree, or a "modified" file reads green in one and grey in the other for no reason a person can
 * see. `modified`/`renamed` stay on the Task-state register: neither is a diff verdict.
 */
const STATUS_TONE: Record<NonNullable<PresentFilesWidget["files"][number]["status"]>, string> = {
  added: "text-diff-added",
  modified: "text-state-running",
  deleted: "text-diff-removed",
  renamed: "text-muted-foreground",
};
