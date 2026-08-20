"use client";

import type {
  WorkflowAdvanceOn,
  WorkflowStepDto,
  WorkflowStepGate,
  WorkflowWithStepsDto,
} from "@gatecontrol/contracts";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/trpc/react";

/**
 * The Step editor (issue #5 AC-1) — the designing half of a Workflow, as an ordered list.
 *
 * A list and not a canvas. The pipeline the issue is written around is linear (one agent plans,
 * another implements, a third reviews), and the node graph of F03's FR-1 buys nothing for a
 * linear pipeline except a layout engine to maintain. Reordering is Move up / Move down rather
 * than drag: both send the same `workflow.reorderStep` call a drag surface would, naming the two
 * Steps the moved one lands between, so adding a pointer affordance later changes no contract.
 *
 * The agent for a Step comes from the Agent Profile catalog (issue #10) and nowhere else — a
 * second way of naming an agent is exactly what AC-3 is trying to avoid.
 */

const GATE_LABELS: Record<WorkflowStepGate, string> = {
  human: "Wait for a human",
  auto: "Advance automatically",
  "auto-unless-changes": "Automatic unless it changed something",
};

const ADVANCE_LABELS: Record<WorkflowAdvanceOn, string> = {
  "agent-signal": "The agent says it is done",
  review: "A review is recorded",
};

function StepCard({
  step,
  index,
  steps,
  profiles,
}: {
  step: WorkflowStepDto;
  index: number;
  steps: readonly WorkflowStepDto[];
  profiles: readonly { id: string; name: string }[];
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.workflow.get.invalidate({ id: step.workflowId });
  const update = trpc.workflow.updateStep.useMutation({ onSuccess: refresh });
  const reorder = trpc.workflow.reorderStep.useMutation({ onSuccess: refresh });
  const remove = trpc.workflow.deleteStep.useMutation({ onSuccess: refresh });
  const [prompt, setPrompt] = useState(step.promptTemplate);

  /**
   * A move by one place, stated as the neighbours it lands between. Moving up past `index - 1`
   * means landing after `index - 2` and before `index - 1`; the ends are nulls.
   */
  const move = (direction: -1 | 1) => {
    const target = index + direction;
    const after = direction === -1 ? (steps[target - 1]?.id ?? null) : (steps[target]?.id ?? null);
    const before = direction === -1 ? (steps[target]?.id ?? null) : (steps[target + 1]?.id ?? null);
    reorder.mutate({ stepId: step.id, afterStepId: after, beforeStepId: before });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">
          <span className="mr-2 text-muted-foreground tabular-nums">{index + 1}.</span>
          {step.name}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Move ${step.name} up`}
            disabled={index === 0}
            onClick={() => move(-1)}
          >
            <ChevronUp aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Move ${step.name} down`}
            disabled={index === steps.length - 1}
            onClick={() => move(1)}
          >
            <ChevronDown aria-hidden className="size-4" />
          </Button>
          <ConfirmAction
            title={`Remove “${step.name}”?`}
            description="Tasks already parked on this step keep it — the removal is refused until they move on."
            confirmLabel="Remove step"
            onConfirm={() => remove.mutate({ stepId: step.id })}
            trigger={
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${step.name}`}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
            }
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={`step-agent-${step.id}`}>Agent profile</Label>
            <Select
              value={step.agentProfileId}
              onValueChange={(v) => update.mutate({ stepId: step.id, agentProfileId: v })}
            >
              <SelectTrigger id={`step-agent-${step.id}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`step-gate-${step.id}`}>Gate</Label>
            <Select
              value={step.gate}
              onValueChange={(v) => update.mutate({ stepId: step.id, gate: v as WorkflowStepGate })}
            >
              <SelectTrigger id={`step-gate-${step.id}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(GATE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`step-advance-${step.id}`}>Finished when</Label>
          <Select
            value={step.advanceOn}
            onValueChange={(v) =>
              update.mutate({ stepId: step.id, advanceOn: v as WorkflowAdvanceOn })
            }
          >
            <SelectTrigger id={`step-advance-${step.id}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ADVANCE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`step-prompt-${step.id}`}>Prompt</Label>
          <Textarea
            id={`step-prompt-${step.id}`}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => {
              if (prompt !== step.promptTemplate) {
                update.mutate({ stepId: step.id, promptTemplate: prompt });
              }
            }}
          />
          <p className="text-muted-foreground text-xs">
            The previous step&rsquo;s handoff is prepended to this when the step runs.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkflowStepEditor({ workflow }: { workflow: WorkflowWithStepsDto }) {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({});
  const [name, setName] = useState("");
  const [agentProfileId, setAgentProfileId] = useState("");

  const add = trpc.workflow.addStep.useMutation({
    onSuccess: () => {
      utils.workflow.get.invalidate({ id: workflow.id });
      utils.workflow.list.invalidate();
      setName("");
    },
  });

  const options = profiles.data ?? [];

  return (
    <section className="space-y-3">
      <ol className="space-y-3" aria-label={`Steps of ${workflow.name}`}>
        {workflow.steps.map((step, index) => (
          <li key={step.id}>
            <StepCard step={step} index={index} steps={workflow.steps} profiles={options} />
          </li>
        ))}
      </ol>

      {workflow.steps.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No steps yet. A workflow with no steps cannot be attached to a task.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add a step</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate({ workflowId: workflow.id, name, agentProfileId });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="new-step-name">Name</Label>
              <Input
                id="new-step-name"
                placeholder="e.g. Review the diff"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-step-agent">Agent profile</Label>
              <Select value={agentProfileId} onValueChange={setAgentProfileId}>
                <SelectTrigger id="new-step-agent" className="w-full">
                  <SelectValue placeholder="Select an agent profile" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!name || !agentProfileId || add.isPending}>
              Add step
            </Button>
          </form>
          {add.error && (
            <p className="mt-2 font-mono text-state-failed text-xs" role="alert">
              {add.error.message}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
