"use client";

import { CreateIssueDialog } from "./create-issue-dialog";
import { CreateTaskDialog } from "./create-task-dialog";

/** Board action bar: conventional create flows open in modal dialogs (TASK-021). */
export function BoardToolbar() {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <CreateIssueDialog />
      <CreateTaskDialog />
    </div>
  );
}
