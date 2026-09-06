"use client";

import type { WorkflowStepGate, WorkflowWithStepsDto } from "@solow/contracts";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { WHOLE_PAGE } from "@/lib/paged";
import { nextStepName, stepDotColors } from "@/lib/workflow-canvas";
import { trpc } from "@/trpc/react";

/**
 * What the secondary sidebar holds on the Workflows surface: the selected pipeline itself.
 *
 * Two tabs, because there are two questions asked here and they want different shapes —
 * **Outline** is "what does this pipeline do, in order", a list you read down; **Properties** is
 * "what is this pipeline called and can I still delete it", a form. Stacking both in one column
 * would put the delete button under a pipeline of arbitrary length.
 *
 * Deliberately *not* here: a Step's own fields. Those stay on the node that draws the Step (see
 * `workflow-canvas.tsx`) — a Step is edited in sight of the Steps it connects to, and moving its
 * agent and prompt into this panel would undo exactly what the node graph is for. The outline
 * navigates to a Step; it does not become a second place to edit one.
 */
const GATE_SUMMARY: Record<WorkflowStepGate, string> = {
  human: "human gate",
  auto: "automatic",
  "auto-unless-changes": "auto unless changed",
};

/**
 * Reveal a Step on the canvas and put the caret in its name.
 *
 * A DOM lookup by `data-step-id` rather than shared selection state: the canvas owns its nodes
 * and this panel is portalled in from outside the tree that renders them, so a store shared
 * between the two would be a second answer to "which Step" for the sake of one scroll. The node
 * carries the attribute already.
 */
function revealStep(stepId: string) {
  const node = document.querySelector<HTMLElement>(`[data-step-id="${stepId}"]`);
  node?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  node?.querySelector("input")?.focus();
}

function Outline({ workflow }: { workflow: WorkflowWithStepsDto }) {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  const add = trpc.workflow.addStep.useMutation({
    onSuccess: () => {
      utils.workflow.get.invalidate({ id: workflow.id });
      utils.workflow.list.invalidate();
    },
  });
  const firstProfile = profiles.data?.items[0];
  const nameOf = (id: string) => profiles.data?.items.find((p) => p.id === id)?.name ?? "…";
  // A branch is the one thing about a Step the outline cannot infer from its place in the list,
  // so it is the one thing said beyond the agent and the gate.
  const stepName = (id: string | null) =>
    id === null ? "end" : (workflow.steps.find((s) => s.id === id)?.name ?? "?");
  // The same colours the canvas draws, from the same list: the dot is the one thing that says
  // "this row is that card" across the two.
  const dots = stepDotColors(workflow.steps);

  return (
    <div className="space-y-2">
      <ol className="space-y-px" aria-label={`Steps of ${workflow.name}`}>
        {workflow.steps.map((step, index) => (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => revealStep(step.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: dots.get(step.id) }}
              />
              <span className="w-3 shrink-0 text-2xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{step.name}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {nameOf(step.agentProfileId)} · {GATE_SUMMARY[step.gate]}
                </span>
                {step.branch && (
                  <span className="block truncate text-2xs text-muted-foreground">
                    yes → {stepName(step.branch.thenStepId)} · no →{" "}
                    {stepName(step.branch.elseStepId)}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {workflow.steps.length === 0 && (
        <p className="px-2 text-muted-foreground text-xs leading-relaxed">
          No steps yet. A workflow with no steps cannot be attached to a task.
        </p>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!firstProfile || add.isPending}
        onClick={() => {
          if (!firstProfile) return;
          add.mutate({
            workflowId: workflow.id,
            name: nextStepName(workflow.steps),
            agentProfileId: firstProfile.id,
          });
        }}
      >
        <Plus aria-hidden />
        Add step
      </Button>
      {!profiles.isLoading && !firstProfile && (
        <p className="px-2 text-muted-foreground text-2xs">
          Create an agent profile first — a step has to name one.
        </p>
      )}
      {add.error && (
        <p className="px-2 font-mono text-2xs text-state-failed" role="alert">
          {add.error.message}
        </p>
      )}
    </div>
  );
}

function Properties({ workflow }: { workflow: WorkflowWithStepsDto }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? "");
  // A refresh carries an edit made elsewhere — on the canvas, or in another tab; the local draft
  // yields to it, the same way a Step node's fields do.
  useEffect(() => setName(workflow.name), [workflow.name]);
  useEffect(() => setDescription(workflow.description ?? ""), [workflow.description]);

  const refresh = () => {
    utils.workflow.get.invalidate({ id: workflow.id });
    utils.workflow.list.invalidate();
  };
  const rename = trpc.workflow.rename.useMutation({ onSuccess: refresh });
  const remove = trpc.workflow.delete.useMutation({
    onSuccess: () => {
      utils.workflow.list.invalidate();
      // Back to the surface with nothing selected: the route named a Workflow that is now gone,
      // and staying on it would draw a NOT_FOUND.
      router.push("/workflows");
    },
  });

  const save = (next: { name?: string; description?: string | null }) =>
    rename.mutate({
      id: workflow.id,
      name: next.name ?? workflow.name,
      description:
        next.description !== undefined ? next.description : (workflow.description ?? null),
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor="workflow-name" className="text-xs">
          Name
        </Label>
        <Input
          id="workflow-name"
          className="h-7 text-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (!trimmed) return setName(workflow.name);
            if (trimmed !== workflow.name) save({ name: trimmed });
          }}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="workflow-description" className="text-xs">
          Description
        </Label>
        <Textarea
          id="workflow-description"
          className="min-h-16 text-xs"
          rows={3}
          placeholder="What this pipeline is for."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            const next = description.trim();
            if (next !== (workflow.description ?? "")) save({ description: next || null });
          }}
        />
      </div>

      <dl className="space-y-1 text-2xs">
        {[
          ["Steps", `${workflow.stepCount}`],
          ["Version", `v${workflow.version}`],
          ["Updated", new Date(workflow.updatedAt).toLocaleString()],
        ].map(([term, value]) => (
          <div key={term} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="truncate font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <ConfirmAction
        title={`Delete “${workflow.name}”?`}
        description="Its steps go with it. Refused while any task still follows it."
        confirmLabel="Delete workflow"
        onConfirm={() => remove.mutate({ id: workflow.id })}
        trigger={
          <Button type="button" variant="outline" size="sm" className="w-full">
            <Trash2 aria-hidden />
            Delete workflow
          </Button>
        }
      />
      {(rename.error || remove.error) && (
        <p className="font-mono text-2xs text-state-failed" role="alert">
          {(rename.error ?? remove.error)?.message}
        </p>
      )}
    </div>
  );
}

export function WorkflowInspector({ workflow }: { workflow: WorkflowWithStepsDto }) {
  return (
    <Tabs defaultValue="outline" className="gap-3 p-2.5">
      <TabsList className="w-full">
        <TabsTrigger value="outline" className="flex-1">
          Outline
        </TabsTrigger>
        <TabsTrigger value="properties" className="flex-1">
          Properties
        </TabsTrigger>
      </TabsList>
      <TabsContent value="outline">
        <Outline workflow={workflow} />
      </TabsContent>
      <TabsContent value="properties">
        <Properties workflow={workflow} />
      </TabsContent>
    </Tabs>
  );
}
