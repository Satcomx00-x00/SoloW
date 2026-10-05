"use client";

import { CommonErrorCode } from "@solow/contracts";
import { TriangleAlert, Workflow as WorkflowIcon } from "lucide-react";
import { FlagDisabled } from "@/components/features/shared/flag-disabled";
import { WorkflowInspector } from "@/components/features/workflows/workflow-inspector";
import { HeaderActions } from "@/components/shell/header-actions";
import { SecondaryPanel } from "@/components/shell/secondary-sidebar";
import { trpc } from "@/trpc/react";
import { WorkflowCanvas } from "./workflow-canvas";
import { WorkflowCreateActions } from "./workflow-create-actions";

/**
 * The Workflows surface (issue #5, spec F03).
 *
 * A Workflow is the thing that makes "multi-harness orchestration" mean more than several
 * single-harness Tasks running at once: an ordered pipeline whose Steps each name their own harness.
 *
 * **This surface is now the canvas and nothing else.** It used to be a three-column page — a
 * create form and a list in a 16rem column, the graph in the rest, all inside a `max-w-7xl` with
 * page padding — which spent a third of the width and a fixed 36rem of height on chrome that the
 * shell already has a place for. The list moved into the sidebar (nested under Workflows), the
 * create controls into the header, the pipeline's own properties into the secondary sidebar, and
 * what is left fills the viewport. That is also why the selection is a prop read from the route rather than component
 * state: three surfaces now draw the same choice, and a `useState` here could only be read by one
 * of them.
 */
export function WorkflowsView({ workflowId }: { workflowId?: string | undefined }) {
  const workflows = trpc.workflow.list.useQuery({});
  const list = workflows.data ?? [];

  // The route names a Workflow; `/workflows` names none and opens on the first, so the surface is
  // never an empty frame when there is something to draw. A stale id — deleted in another tab —
  // falls back the same way rather than leaving the canvas on a NOT_FOUND forever.
  const selected = list.find((w) => w.id === workflowId) ?? list[0] ?? null;
  const detail = trpc.workflow.get.useQuery(
    { id: selected?.id ?? "" },
    { enabled: selected !== null },
  );

  const actions = (
    <HeaderActions>
      <WorkflowCreateActions installed={list} />
    </HeaderActions>
  );

  if (workflows.error) {
    return workflows.error.message === CommonErrorCode.FlagDisabled ? (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <FlagDisabled flag="ff-workflows" title="Workflows are not enabled here" />
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

  if (detail.data) {
    return (
      <>
        {actions}
        <WorkflowCanvas workflow={detail.data} />
        {/* The pipeline's own settings — its name, its Steps as a list — go to the secondary
            sidebar rather than onto the canvas, which is the whole point of having one. */}
        <SecondaryPanel title="Workflow">
          <WorkflowInspector workflow={detail.data} />
        </SecondaryPanel>
      </>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {actions}
      <WorkflowIcon aria-hidden className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
      <p className="text-muted-foreground text-sm">
        {selected
          ? "Loading steps…"
          : workflows.isLoading
            ? "Loading workflows…"
            : "No workflows yet. A workflow chains harnesses: one plans, another implements, a third reviews."}
      </p>
      {!selected && !workflows.isLoading && (
        <p className="text-muted-foreground/70 text-xs">Start one with New workflow, above.</p>
      )}
    </div>
  );
}
