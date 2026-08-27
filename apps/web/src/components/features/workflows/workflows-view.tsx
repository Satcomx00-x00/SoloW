"use client";

import { CommonErrorCode } from "@solow/contracts";
import { Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { WorkflowStepEditor } from "./workflow-step-editor";

/**
 * The Workflows section (issue #5, spec F03).
 *
 * A Workflow is the thing that makes "multi-agent orchestration" mean more than several
 * single-agent Tasks running at once: an ordered pipeline whose Steps each name their own agent.
 * This is the surface where one is defined — a list on the left, the selected pipeline's Steps
 * on the right.
 *
 * The monitor half of F03 (a run's live position on the pipeline) belongs with the run loop that
 * produces the timings, and is not here.
 */
export function WorkflowsView() {
  const utils = trpc.useUtils();
  const workflows = trpc.workflow.list.useQuery({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");

  const create = trpc.workflow.create.useMutation({
    onSuccess: (created) => {
      utils.workflow.list.invalidate();
      setSelectedId(created.id);
      setName("");
    },
  });
  const remove = trpc.workflow.delete.useMutation({
    onSuccess: () => {
      utils.workflow.list.invalidate();
      setSelectedId(null);
    },
  });

  const list = workflows.data ?? [];
  // The selection follows the list rather than being remembered independently: a Workflow
  // deleted in another tab would otherwise leave this pane rendering a NOT_FOUND forever.
  const selected = list.find((w) => w.id === selectedId) ?? list[0] ?? null;
  const detail = trpc.workflow.get.useQuery(
    { id: selected?.id ?? "" },
    { enabled: selected !== null },
  );

  if (workflows.error) {
    return workflows.error.message === CommonErrorCode.FlagDisabled ? (
      <div className="mx-auto w-full max-w-3xl space-y-3 px-6 py-10" role="alert">
        <h2 className="font-medium text-sm">Workflows are not enabled here</h2>
        <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
          Feature flags ship off. Enable it from the machine running this instance:
        </p>
        <pre className="w-fit rounded-lg border bg-card px-3 py-2 font-mono text-xs">
          bun run flag enable ff-workflows
        </pre>
      </div>
    ) : (
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2.5 px-6 py-10 text-sm">
        <TriangleAlert className="mt-px size-4 shrink-0 text-state-failed" aria-hidden />
        <div role="alert">
          <p className="font-medium">Failed to load workflows</p>
          <p className="mt-0.5 font-mono text-muted-foreground text-xs">
            {workflows.error.message}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-5">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="font-semibold text-lg">Workflows</h1>
        {/* No run loop drives a Task through these Steps yet (issue #5) — the badge says so
            before a click does, not after. */}
        <Badge variant="outline" className="text-2xs">
          WIP
        </Badge>
      </div>
      <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
        <div className="space-y-4">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ name });
            }}
          >
            <Label htmlFor="new-workflow-name">New workflow</Label>
            <Input
              id="new-workflow-name"
              placeholder="e.g. Plan, build, review"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Button type="submit" className="w-full" disabled={!name || create.isPending}>
              Create workflow
            </Button>
            {create.error && (
              <p className="font-mono text-state-failed text-xs" role="alert">
                {create.error.message}
              </p>
            )}
          </form>

          <ul className="space-y-1" aria-label="Workflows">
            {list.map((w) => (
              <li key={w.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-current={selected?.id === w.id ? "true" : undefined}
                  onClick={() => setSelectedId(w.id)}
                  className={cn(
                    "min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                    selected?.id === w.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className="block truncate">{w.name}</span>
                  <span className="block text-2xs text-muted-foreground tabular-nums">
                    {w.stepCount === 1 ? "1 step" : `${w.stepCount} steps`} · v{w.version}
                  </span>
                </button>
                <ConfirmAction
                  title={`Delete “${w.name}”?`}
                  description="Its steps go with it. Refused while any task still follows it."
                  confirmLabel="Delete workflow"
                  onConfirm={() => remove.mutate({ id: w.id })}
                  trigger={
                    <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${w.name}`}>
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
          {remove.error && (
            <p className="font-mono text-state-failed text-xs" role="alert">
              {remove.error.message}
            </p>
          )}
          {!workflows.isLoading && list.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No workflows yet. A workflow chains agents: one plans, another implements, a third
              reviews.
            </p>
          )}
        </div>

        <div>
          {detail.data ? (
            <WorkflowStepEditor workflow={detail.data} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {selected ? "Loading steps…" : "Select a workflow to edit its steps."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
