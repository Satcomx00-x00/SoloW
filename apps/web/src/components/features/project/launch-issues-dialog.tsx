"use client";

import { CheckCircle2, CircleAlert, GitBranch, Loader2, Play, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useWorkflowChoices } from "@/components/features/task/launch-task-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_PAGE } from "@/lib/paged";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import type { ProjectRow } from "./project-table";

const NONE = "__none__";

interface RowOutcome {
  status: "pending" | "done" | "error";
  message?: string;
}

/**
 * A row this dialog cannot launch, and why — the same two guards the table's own single-row
 * "Start a task on this issue" applies (its item is hidden without them), stated instead of
 * silently dropped, because a batch that quietly launched fewer issues than were checked would
 * read as a bug the moment anyone counted.
 */
function ineligibleReason(row: ProjectRow): string | null {
  if (row.issueNumber === null) return "no provider issue";
  if (row.item.repositoryId === null) return "no repository";
  return null;
}

/**
 * Launch several Issues at once, on one Workflow (user request 2026-09-08): the project table's
 * multi-row selection asks exactly one extra question — which Harness, which Executor, and
 * optionally which Workflow — then runs the ordinary single-Task sequence once per row:
 * `task.create` (lands in the backlog), an optional `workflow.attachTask`, `task.move` to
 * `ready` (the board's own gesture — `task.launch` refuses anything still in the backlog), then
 * `task.launch`. See `LaunchTaskDialog` for the single-row launch this mirrors, and `board.tsx`'s
 * `renderActions` for the "Ready" button this stands in for.
 *
 * Not a new server procedure. A batch endpoint would still have to invent a partial-failure
 * shape of its own, and the four calls this makes per row are already the calls the board makes
 * one at a time — so this dialog runs them N times, sequentially, and shows each row its own
 * outcome. One Issue with, say, no Repository attached refuses without taking the rest of the
 * batch down with it, the same principle `resumeTask`'s own comment states for its resume sweep.
 */
export function LaunchIssuesDialog({
  rows,
  onOpenChange,
}: {
  /** The rows the operator checked, or null while the dialog is closed. */
  rows: ProjectRow[] | null;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const harnesses = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const executors = trpc.profile.executor.list.useQuery({ ...WHOLE_PAGE });
  const { workflows } = useWorkflowChoices();

  const [agentProfileId, setAgentProfileId] = useState("");
  const [executorProfileId, setExecutorProfileId] = useState("");
  const [workflowChoice, setWorkflowChoice] = useState<string>(NONE);
  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({});
  const [running, setRunning] = useState(false);

  // Each opening starts blank, the same reason `LaunchTaskDialog` resets on a fresh `task`: a
  // second selection must not launch on the profiles the last batch happened to leave chosen.
  useEffect(() => {
    if (rows) {
      setAgentProfileId("");
      setExecutorProfileId("");
      setWorkflowChoice(NONE);
      setOutcomes({});
      setRunning(false);
    }
  }, [rows]);

  const all = rows ?? [];
  const eligible = all.filter((r) => ineligibleReason(r) === null);

  const createTask = trpc.task.create.useMutation();
  const attachWorkflow = trpc.workflow.attachTask.useMutation();
  const readyTask = trpc.task.move.useMutation();
  const launchTask = trpc.task.launch.useMutation();

  const submitted = Object.keys(outcomes).length > 0;
  const finished =
    submitted && !running && Object.values(outcomes).every((o) => o.status !== "pending");
  const failedCount = Object.values(outcomes).filter((o) => o.status === "error").length;

  const submit = async () => {
    setRunning(true);
    setOutcomes(Object.fromEntries(eligible.map((r) => [r.item.id, { status: "pending" }])));
    for (const row of eligible) {
      const repositoryId = row.item.repositoryId;
      if (repositoryId === null) continue; // excluded by `eligible` already; narrows the type
      try {
        const task = await createTask.mutateAsync({
          issueId: row.item.issueId,
          title: row.title,
          agentProfileId,
          executorProfileId,
          repositories: [{ repositoryId }],
        });
        if (workflowChoice !== NONE) {
          await attachWorkflow.mutateAsync({ taskId: task.id, workflowId: workflowChoice });
        }
        // A fresh Task lands in the backlog — the board's own "Ready" gesture — before
        // `task.launch` will look at it at all (`isLaunchable` only accepts `ready`).
        await readyTask.mutateAsync({ id: task.id, to: "ready" });
        await launchTask.mutateAsync({ id: task.id });
        setOutcomes((o) => ({ ...o, [row.item.id]: { status: "done" } }));
      } catch (error) {
        setOutcomes((o) => ({
          ...o,
          [row.item.id]: {
            status: "error",
            message: error instanceof Error ? error.message : "Failed to launch",
          },
        }));
      }
    }
    setRunning(false);
    void utils.task.list.invalidate();
    void utils.workflow.taskBinding.invalidate();
  };

  const missingConfig =
    (harnesses.data?.items.length ?? 0) === 0 || (executors.data?.items.length ?? 0) === 0;
  const canSubmit =
    eligible.length > 0 && agentProfileId !== "" && executorProfileId !== "" && !running;

  return (
    <Dialog
      open={rows !== null}
      onOpenChange={(next) => {
        // A batch mid-flight is not something a stray click on the backdrop should abandon —
        // each row's own mutation keeps running either way, so closing here would just hide the
        // outcomes without stopping anything.
        if (running) return;
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            Launch {all.length} issue{all.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            One Harness, one Executor and — optionally — one Workflow, applied to every issue below.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {missingConfig ? (
            <p className="text-muted-foreground text-sm">
              Configure a Harness Profile and an Executor Profile in{" "}
              <span className="font-medium text-foreground">Settings</span> first.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <span className="font-medium text-sm">Harness</span>
                <Select value={agentProfileId} onValueChange={setAgentProfileId} disabled={running}>
                  <SelectTrigger className="w-full" aria-label="Harness">
                    <SelectValue placeholder="Select a harness" />
                  </SelectTrigger>
                  <SelectContent>
                    {(harnesses.data?.items ?? []).map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <span className="font-medium text-sm">Executor</span>
                <Select
                  value={executorProfileId}
                  onValueChange={setExecutorProfileId}
                  disabled={running}
                >
                  <SelectTrigger className="w-full" aria-label="Executor">
                    <SelectValue placeholder="Select an executor" />
                  </SelectTrigger>
                  <SelectContent>
                    {(executors.data?.items ?? []).map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {workflows.length > 0 && (
            <div className="space-y-1.5">
              <span className="font-medium text-sm">Workflow</span>
              <Select value={workflowChoice} onValueChange={setWorkflowChoice} disabled={running}>
                <SelectTrigger className="w-full" aria-label="Workflow">
                  <SelectValue placeholder="No workflow" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    <Sparkles aria-hidden className="size-3.5" />
                    No workflow
                  </SelectItem>
                  {workflows.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      <GitBranch aria-hidden className="size-3.5" />
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <ul className="max-h-64 space-y-0.5 overflow-auto rounded-md border p-1.5">
            {all.map((row) => {
              const reason = ineligibleReason(row);
              const outcome = outcomes[row.item.id];
              return (
                <li
                  key={row.item.id}
                  className={cn(
                    "flex items-center gap-2 rounded px-1.5 py-1 text-xs",
                    reason && "text-muted-foreground/60",
                  )}
                >
                  <span className="w-10 shrink-0 font-mono text-2xs tabular-nums">
                    {row.issueNumber === null ? "—" : `#${row.issueNumber}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{row.title}</span>
                  {reason ? (
                    <span className="shrink-0 text-2xs">Skipped — {reason}</span>
                  ) : outcome?.status === "pending" ? (
                    <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
                  ) : outcome?.status === "done" ? (
                    <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-feedback-ok" />
                  ) : outcome?.status === "error" ? (
                    <span
                      className="flex shrink-0 items-center gap-1 text-feedback-error"
                      title={outcome.message}
                    >
                      <CircleAlert aria-hidden className="size-3.5" />
                      Failed
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {finished && failedCount > 0 && (
            <p className="text-feedback-error text-xs" role="alert">
              {failedCount} of {eligible.length} did not launch — see each row above.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {/* Not "Close" — the dialog's own X carries that name already, and a reader using a
                screen reader would hear two identically named controls. */}
            {finished ? "Done" : "Cancel"}
          </Button>
          {!finished && (
            <Button
              type="button"
              loading={running}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              <Play aria-hidden />
              Launch {eligible.length} issue{eligible.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
