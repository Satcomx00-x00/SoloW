"use client";

import "@xyflow/react/dist/style.css";

import type {
  HarnessPermissionMode,
  McpServerDto,
  SkillDto,
  TaskCompletionOutcome,
  WorkflowAdvanceOn,
  WorkflowStepBranch,
  WorkflowStepCondition,
  WorkflowStepDto,
  WorkflowStepGate,
  WorkflowWithStepsDto,
} from "@solow/contracts";
import { validateWorkflowGraph, type WorkflowGraphProblem } from "@solow/core";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Connection,
  type ConnectionLineComponentProps,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  NodeToolbar,
  type OnNodesChange,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodes,
  useNodesState,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { ChevronsUpDown, GitBranch, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WHOLE_PAGE } from "@/lib/paged";
import {
  branchRetarget,
  END_NODE_ID,
  endNodePosition,
  laneLabelX,
  MAIN_LINE_Y,
  NODE_ORIGIN,
  nextStepName,
  placeSteps,
  reorderFromDrop,
  roundedPath,
  START_NODE_ID,
  START_NODE_WIDTH,
  STEP_NODE_GAP,
  STEP_NODE_WIDTH,
  type StepEdgeKind,
  startNodePosition,
  stepDotColors,
  stepEdges,
} from "@/lib/workflow-canvas";
import { trpc } from "@/trpc/react";
import { COMPACT_ZOOM, FIT_VIEW } from "./workflow-canvas-zoom";

/**
 * The Workflow designer as a node graph (issue #5 AC-1, F03 FR-1/FR-4, Decision 0007).
 *
 * Each Step is a node that *is* its own form — harness, gate, advance rule, prompt — rather than a
 * node that opens one: the pipeline is meant to be read and edited in one glance, and a side
 * panel would put the thing being edited out of sight of the thing it connects to. Every edit
 * is a `workflow.updateStep` on blur or on change, exactly what the list editor this replaces
 * sent; the contracts did not move.
 *
 * Order is the rank, and the canvas never stores a position. Nodes are laid out from the Step
 * list on every change, and a drag is a *statement about order* — where the node is let go is
 * turned into the neighbour pair `workflow.reorderStep` takes, then the node snaps back to its
 * laid-out place and the refreshed list moves it for real. Dropping it somewhere and leaving it
 * there would be a second, unsaved layout for the run loop to disagree with.
 *
 * Edges are not the operator's to draw. They are the run loop's next-Step rule made visible —
 * `stepEdges` derives them from the list. A Step without a branch has one exit, to its rank
 * successor; a Step *with* one has a `Yes` exit and a `No` exit, each pointing wherever the
 * branch says, including backwards and including the `End` node. Changing where an exit goes is
 * done on the node that owns it — in the same form as its harness and prompt — or by *dragging the
 * exit itself* onto the Step it should reach, which is the one connect gesture there is
 * (`branchRetarget`): it re-points a branch that already exists, and cannot create an edge the
 * model has no row for. The plain `next` exit and the start are not draggable at all.
 *
 * What the canvas cannot show is therefore what the model cannot hold (F03 FR-5, and the list in
 * the spec under *What a Workflow graph cannot be*): a second start, a second end, an edge from
 * nowhere, a Step with no exit, three exits, an edge into another Workflow. The two shapes the
 * model *can* hold but must not run — a Step nothing leads to, a loop with no way out — are
 * `validateWorkflowGraph`'s to find, and are said on the node in words rather than refused at
 * the keystroke: an operator building a loop passes through both on the way.
 */

// Short enough to read whole in a half-width control; the label is the whole explanation a
// node has room for.
const GATE_LABELS: Record<WorkflowStepGate, string> = {
  human: "A human approves",
  auto: "Automatic",
  "auto-unless-changes": "Automatic unless changed",
};

const ADVANCE_LABELS: Record<WorkflowAdvanceOn, string> = {
  "agent-signal": "Harness says done",
  review: "Review recorded",
};

const CONDITION_LABELS: Record<WorkflowStepCondition["kind"], string> = {
  "agent-decides": "The harness decides",
  "produced-changes": "Step produced changes",
  outcome: "Harness reported an outcome",
};

/** The three ways a harness can say its run ended, as the `outcome` condition offers them. */
const OUTCOME_LABELS: Record<TaskCompletionOutcome, string> = {
  changes_ready: "Changes ready",
  nothing_to_do: "Nothing to do",
  blocked: "Blocked — could not finish",
};

/**
 * What an `outcome` condition asks about when the operator first picks it. `blocked` rather than
 * the ordinary ending, because routing a stuck harness somewhere other than the review gate is
 * the case this condition exists for.
 */
const DEFAULT_OUTCOME: TaskCompletionOutcome = "blocked";

/**
 * The question a branch is born with. Deliberately a question about the question: it is there
 * to be replaced, and both targets point where the Step already went, so nothing happens until
 * the operator has written the one they mean.
 */
const PLACEHOLDER_QUESTION = "Is the condition met?";

/**
 * The Select value that stands for "the pipeline ends here". A Radix Select cannot carry an empty
 * string and a null target has a meaning, so the end gets a name of its own; `END_NODE_ID` is
 * safe because no Step id is a bare word.
 */
const END_TARGET = END_NODE_ID;

/**
 * What a Step is given when the operator first asks it to branch: both exits pointing where the
 * Step already went, so turning the branch on changes nothing until a target is chosen, and the
 * condition the harness answers — the one the feature exists for.
 */
function defaultBranch(successorId: string | null): WorkflowStepBranch {
  return {
    when: { kind: "agent-decides", question: PLACEHOLDER_QUESTION },
    thenStepId: successorId,
    elseStepId: successorId,
  };
}

type Profile = { id: string; name: string };

/**
 * The pipeline in view — never enlarged past 1:1, because a two-Step pipeline blown up to fill a
 * wide screen reads as a mistake, and never *shrunk* past 0.6, because a fit that makes the
 * forms unreadable is not a fit. A long pipeline is pannable; a tiny one is useless.
 */
/** Every edge ends in an arrowhead: a pipeline has a direction, and a dash alone has none. */
const ARROW = { type: MarkerType.ArrowClosed, width: 14, height: 14 } as const;

/** How long the node toolbar survives the pointer leaving, so crossing the gap to it is possible. */
const TOOLBAR_LINGER_MS = 140;

/** One shared empty list, so an unloaded catalog is the same value on every render. */
const NO_PROFILES: readonly Profile[] = [];

/** What a problem with a Step's place in the graph says on the node. */
const PROBLEM_TEXT: Record<WorkflowGraphProblem["kind"], string> = {
  unreachable: "Unreachable — no step leads here, so it never runs.",
  "no-exit": "No way out — from here the pipeline can never end.",
};

/** The libraries a Step can name (spec F24), or null where the feature is off. */
type Libraries = { mcp: readonly McpServerDto[]; skills: readonly SkillDto[] } | null;

type StepNodeData = {
  step: WorkflowStepDto;
  index: number;
  libraries: Libraries;
  /** The dot's colour — this Step's own, resolved against its siblings (`stepDotColors`). */
  dotColor: string;
  /** Why this Step cannot be run as it stands, if it cannot. */
  problems: readonly WorkflowGraphProblem["kind"][];
  profiles: readonly Profile[];
  /** Every Step of the pipeline, in rank order — what a branch target is chosen from. */
  siblings: readonly Pick<WorkflowStepDto, "id" | "name">[];
  onAddAfter: (stepId: string) => void;
  /** Is a Step being added, or is there no Harness Profile to give one? Either dims the `+`. */
  adding: boolean;
};

type StepNode = Node<StepNodeData, "step">;
type StartNode = Node<{ onAddAtStart: () => void; adding: boolean }, "start">;
type EndNode = Node<Record<string, never>, "end">;
type CanvasNode = StepNode | StartNode | EndNode;

/**
 * Where a Step's two conditional exits sit on its right edge. `Yes` stays on the main line — it
 * is usually the way the pipeline carries on — and `No` hangs below it, far enough to read as a
 * second exit and to keep its label clear of the `+` on the main line.
 *
 * Percentages of the card rather than pixels from its top: every node is centred on the axis
 * now, so the card's own middle *is* the line, whatever the card is currently showing.
 */
const BRANCH_EXIT_DROP = 56;
const MAIN_LINE_TOP = "50%";
const THEN_HANDLE_TOP = MAIN_LINE_TOP;
const ELSE_HANDLE_TOP = `calc(50% + ${BRANCH_EXIT_DROP}px)`;

/** The shortest a card may be and still have room for a `No` exit below its middle. */
const BRANCHING_MIN_HEIGHT = 2 * (BRANCH_EXIT_DROP + 24);

/**
 * Form controls inside a draggable node need `nodrag` — otherwise selecting text in a field
 * drags the whole Step — and a textarea needs `nowheel` so scrolling its overflow does not
 * zoom the canvas instead.
 */
const FIELD = "nodrag";
const SCROLLING_FIELD = "nodrag nowheel";

/**
 * The branch section of a Step node: off by default, a compact form once on.
 *
 * Every change is a `workflow.updateStep` carrying the whole branch, because the server checks
 * the two targets together — the same reason `reorderStep` sends a neighbour pair rather than a
 * position. The question of an `agent-decides` condition saves on blur like the prompt does; the
 * selects save on change like the gate does.
 */
export function BranchFields({
  step,
  siblings,
  save,
}: {
  step: WorkflowStepDto;
  siblings: readonly Pick<WorkflowStepDto, "id" | "name">[];
  save: (branch: WorkflowStepBranch | null) => void;
}) {
  const branch = step.branch;
  const savedQuestion = branch?.when.kind === "agent-decides" ? branch.when.question : "";
  const [question, setQuestion] = useState(savedQuestion);
  useEffect(() => setQuestion(savedQuestion), [savedQuestion]);
  /*
   * Latest-wins. Every save carries the whole branch, so each field merges its change into a
   * base — and that base is the last branch this editor *sent*, not the prop, which lags a round
   * trip behind. Merging into the prop lost the first of two quick edits: the Condition set to
   * "produced changes", then "If yes" picked before the refresh landed, and the target's save
   * carried the prop's `agent-decides` back to the server. The branching control check caught
   * it; an operator working down the fields is just as quick.
   */
  const latest = useRef(branch);
  useEffect(() => {
    latest.current = branch;
  }, [branch]);
  const put = (next: WorkflowStepBranch) => {
    latest.current = next;
    save(next);
  };
  const base = () => latest.current ?? branch;

  // Turning a branch *on* is the node toolbar's job now (`StepTools`): a full-width button for a
  // thing most Steps never become was the last row of every card, and it read as a field.
  if (!branch) return null;

  const others = siblings.filter((s) => s.id !== step.id);
  const target = (kind: "then" | "else", label: string) => {
    const value = (kind === "then" ? branch.thenStepId : branch.elseStepId) ?? END_TARGET;
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={`step-${kind}-${step.id}`} className="text-xs">
          {label}
        </Label>
        <Select
          value={value}
          onValueChange={(v) => {
            const id = v === END_TARGET ? null : v;
            const b = base();
            if (!b) return;
            put(kind === "then" ? { ...b, thenStepId: id } : { ...b, elseStepId: id });
          }}
        >
          <SelectTrigger id={`step-${kind}-${step.id}`} className={`${FIELD} h-7 w-full text-xs`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {others.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
            <SelectItem value={END_TARGET}>End of pipeline</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-2">
      <div className="flex items-center gap-1.5">
        <GitBranch aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="flex-1 font-medium text-xs">Branch</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={FIELD}
          aria-label={`Remove the branch of ${step.name}`}
          onClick={() => save(null)}
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`step-condition-${step.id}`} className="text-xs">
          Condition
        </Label>
        <Select
          value={branch.when.kind}
          onValueChange={(v) => {
            const kind = v as WorkflowStepCondition["kind"];
            const b = base();
            if (!b) return;
            put({
              ...b,
              when:
                kind === "agent-decides"
                  ? { kind, question: question.trim() || PLACEHOLDER_QUESTION }
                  : kind === "outcome"
                    ? { kind, is: DEFAULT_OUTCOME }
                    : { kind },
            });
          }}
        >
          <SelectTrigger id={`step-condition-${step.id}`} className={`${FIELD} h-7 w-full text-xs`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(CONDITION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {branch.when.kind === "agent-decides" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`step-question-${step.id}`} className="sr-only">
            Question the harness answers
          </Label>
          <Textarea
            id={`step-question-${step.id}`}
            className={`${SCROLLING_FIELD} min-h-12 text-xs`}
            rows={2}
            placeholder="e.g. Does this change need a design review first?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onBlur={() => {
              const trimmed = question.trim();
              if (!trimmed) return setQuestion(savedQuestion);
              if (trimmed !== savedQuestion) {
                const b = base();
                if (b) put({ ...b, when: { kind: "agent-decides", question: trimmed } });
              }
            }}
          />
          <p className="text-2xs text-muted-foreground leading-snug">
            Asked of the harness at the end of this step; it answers yes or no on its completion
            report.
          </p>
        </div>
      )}
      {branch.when.kind === "outcome" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`step-outcome-${step.id}`} className="text-xs">
            When the harness reports
          </Label>
          <Select
            value={branch.when.is}
            onValueChange={(v) => {
              const b = base();
              if (b) put({ ...b, when: { kind: "outcome", is: v as TaskCompletionOutcome } });
            }}
          >
            <SelectTrigger id={`step-outcome-${step.id}`} className={`${FIELD} h-7 w-full text-xs`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-2xs text-muted-foreground leading-snug">
            Read off the harness&apos;s own completion report. A harness that reported nothing
            matches no outcome.
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {target("then", "If yes")}
        {target("else", "If no")}
      </div>
    </div>
  );
}

/**
 * The `+` in the gap after a node — dead centre of the gap the layout leaves, which puts it on
 * the edge to the next Step and makes it read as "insert here" rather than as one more field of
 * the node it hangs off. Solid, so the edge's dashes stop at its rim; it grows a little under
 * the pointer, because at a fitted zoom it is the smallest target on the canvas.
 */
function AddInGap({
  label,
  disabled,
  onClick,
  top = MAIN_LINE_TOP,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** Where the node's exit is: the middle of a card, which is the axis, or of a pill. */
  top?: number | string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className={`${FIELD} -translate-y-1/2 absolute z-10 rounded-full border-muted-foreground/40 bg-background text-foreground shadow-sm transition-transform hover:scale-110 hover:border-foreground`}
      style={{ right: -(STEP_NODE_GAP / 2) - 14, top }}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Plus aria-hidden />
    </Button>
  );
}

/** The pill that names a branch exit — the same object on a node's edge and out on a lane. */
const CHIP =
  "pointer-events-none rounded-full border bg-card px-1.5 py-px font-medium text-[9px] text-muted-foreground uppercase leading-tight tracking-wide";

/**
 * How far past the card's right edge an exit chip starts, and how far above its own line it
 * floats. Both are what keep it out of three things it used to be on top of.
 *
 * The gap is 4px rather than a rounder number because of what is next to it: the `+` is 28px
 * wide and centred half a gap out, so it begins 34px past the card. A `yes` chip is about 26px
 * wide, and the two share the main line — 4px leaves the clearance between them visible instead
 * of letting them abut.
 */
const CHIP_GAP = 4;
const CHIP_LIFT = 4;

/**
 * A tiny pill naming an exit, on the stub of the edge it names.
 *
 * It used to sit *inside* the card, 6px in from the right border — which put it on top of three
 * things at once: the handle dot, whose inner half reaches exactly that far in; the branch form's
 * full-width selects, which run the width of the card; and, for `yes`, the `+` in the gap, since
 * the exit, its chip and the insert button all live on the main line. Outside the card and lifted
 * clear of the line, it labels the edge rather than covering the form, and the line it names runs
 * underneath it.
 *
 * The card has no `overflow: hidden` — the `+` already hangs off it the same way — so there is
 * nothing to clip a chip in the gap.
 */
function ExitChip({ top, children }: { top: number | string; children: string }) {
  return (
    <span
      aria-hidden
      className={`${CHIP} absolute left-full`}
      style={{ top, transform: `translate(${CHIP_GAP}px, calc(-100% - ${CHIP_LIFT}px))` }}
    >
      {children}
    </span>
  );
}

/** The dot an edge leaves from or lands on. Ringed in the card colour so it sits *on* the border. */
const HANDLE = "!size-2.5 !border-2 !border-card !bg-muted-foreground";

/**
 * One library, as a Step picks from it: a dropdown with a search box and a checkbox per item.
 *
 * A `Command` inside a `Popover` rather than a list of checkboxes on the card: a library of
 * twenty servers would make every node twenty rows taller, and the search is what finds the
 * one among them. The trigger reads the choice back in a line, so the card still says what the
 * Step loads without being opened. An item switched on Workspace-wide is checked and cannot be
 * cleared here — it is loaded whether or not the Step asks — and says so in the row.
 */
function LibraryPicker({
  label,
  stepName,
  items,
  chosen,
  onChange,
}: {
  label: string;
  stepName: string;
  items: readonly { id: string; name: string; description: string | null; enabled: boolean }[];
  chosen: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const loads = items.filter((item) => item.enabled || chosen.includes(item.id));
  const summary = loads.length === 0 ? "None" : loads.map((item) => item.name).join(", ");
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...chosen, id])] : chosen.filter((x) => x !== id));
  return (
    <div className="grid gap-1">
      <span className="text-2xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label={`${label} for ${stepName}`}
            className={`${FIELD} h-7 w-full justify-between overflow-hidden px-2 font-normal text-xs`}
          >
            {/*
             * `min-w-0` is what makes the `truncate` bite: a flex child defaults to
             * `min-width: auto`, so a summary of six skills refused to shrink and ran out past
             * the button — and past the node's own border, since the card does not clip.
             */}
            <span
              className={`min-w-0 truncate font-mono ${loads.length === 0 ? "text-muted-foreground" : ""}`}
            >
              {summary}
            </span>
            <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder={`Search ${label.toLowerCase()}…`} className="h-8 text-xs" />
            <CommandList>
              <CommandEmpty>Nothing in the library matches.</CommandEmpty>
              <CommandGroup>
                {items.map((item) => {
                  const on = item.enabled || chosen.includes(item.id);
                  return (
                    <CommandItem
                      key={item.id}
                      value={`${item.name} ${item.description ?? ""}`}
                      disabled={item.enabled}
                      onSelect={() => toggle(item.id, !on)}
                      className="gap-2 text-xs"
                    >
                      <Checkbox
                        checked={on}
                        disabled={item.enabled}
                        tabIndex={-1}
                        aria-label={`Load ${item.name} in ${stepName}`}
                        className="pointer-events-none"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="block truncate font-mono">{item.name}</span>
                        {item.description && (
                          <span className="block truncate text-2xs text-muted-foreground">
                            {item.description}
                          </span>
                        )}
                      </span>
                      {item.enabled && (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          every harness
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Read back on the node, in the words the Harness Profile form already uses. */
const PERMISSION_LABELS: Record<HarnessPermissionMode, string> = {
  acceptEdits: "Edit files, ask for the rest",
  plan: "Read only, change nothing",
  bypassPermissions: "Never ask",
};

/** The `Select` cannot hold null, and "" is not a permission mode, so the absence gets a name. */
const FROM_PROFILE = "profile";

/**
 * What this Step launches its harness with: the libraries it loads on top of the Workspace-wide
 * ones (spec F24), and how much that harness may do without asking (spec F05).
 *
 * The three sit together because they are one idea. **A Step is a harness launch** — a Task under
 * a Workflow starts a fresh session at every Step, with that Step's Profile, that Step's servers
 * and Skills, and that Step's brief — so the permission posture is a launch parameter exactly
 * like the other two, and it belongs where they are rather than on a Profile in Settings. Wanting
 * a *plan* Step and a *build* Step on one Profile is the ordinary shape of a pipeline; before
 * this it took two Profiles differing in a single enum, each with its own credential binding.
 *
 * The default stays *Harness profile*, and that is not a placeholder: it is the answer for every
 * Step that has no opinion, and it keeps following the Profile when the Profile is re-postured.
 */
function LoadsFields({
  step,
  libraries,
  save,
}: {
  step: WorkflowStepDto;
  libraries: Libraries;
  save: (patch: {
    mcpServerIds?: string[];
    skillIds?: string[];
    permissionMode?: HarnessPermissionMode | null;
  }) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Launches with</Label>
      {libraries && libraries.mcp.length > 0 && (
        <LibraryPicker
          label="MCP servers"
          stepName={step.name}
          items={libraries.mcp}
          chosen={step.mcpServerIds}
          onChange={(mcpServerIds) => save({ mcpServerIds })}
        />
      )}
      {libraries && libraries.skills.length > 0 && (
        <LibraryPicker
          label="Skills"
          stepName={step.name}
          items={libraries.skills}
          chosen={step.skillIds}
          onChange={(skillIds) => save({ skillIds })}
        />
      )}
      <div className="grid gap-1">
        <span className="text-2xs text-muted-foreground uppercase tracking-wide">Permissions</span>
        <Select
          value={step.permissionMode ?? FROM_PROFILE}
          onValueChange={(v) =>
            save({
              permissionMode: v === FROM_PROFILE ? null : (v as HarnessPermissionMode),
            })
          }
        >
          <SelectTrigger
            aria-label={`Permissions for ${step.name}`}
            className={`${FIELD} h-7 w-full text-xs`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Not "Harness profile": that is the label of the select two rows up, and one card
                carrying the same words twice for two different questions reads as a mistake. */}
            <SelectItem value={FROM_PROFILE}>Same as the harness profile</SelectItem>
            {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * The Step's prompt: two clamped lines on the card, the whole thing in a dialog.
 *
 * A prompt worth writing is longer than a 320px node has room for, and the three-row textarea
 * that used to sit here meant composing one through a letterbox — scrolling a field the size of
 * a tooltip while the canvas waited to be zoomed by the wheel. The card now only *reads* the
 * prompt back, at a fixed height however long it grows, and the writing happens in a box with
 * room for it.
 *
 * Cancel restores the saved text and Escape does the same, which is the one place in this node
 * that departs from its save-on-blur idiom: dismissing a dialog is how a draft is thrown away
 * everywhere else in the app, and silently committing on a stray click outside would be worse.
 */
function PromptField({
  step,
  save,
}: {
  step: WorkflowStepDto;
  save: (promptTemplate: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(step.promptTemplate);
  // A refreshed list carries an edit made elsewhere; the local draft yields to it.
  useEffect(() => setDraft(step.promptTemplate), [step.promptTemplate]);

  const preview = step.promptTemplate.trim();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`step-prompt-${step.id}`} className="text-xs">
        Prompt
      </Label>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setDraft(step.promptTemplate);
          setOpen(next);
        }}
      >
        <DialogTrigger asChild>
          <button
            type="button"
            id={`step-prompt-${step.id}`}
            aria-label={`Edit the prompt for ${step.name}`}
            className={`${FIELD} min-h-16 w-full rounded-md border bg-transparent px-2.5 py-1.5 text-left text-xs leading-snug transition-colors duration-100 hover:border-ring/40 hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none`}
          >
            {preview ? (
              <span className="line-clamp-2 whitespace-pre-wrap break-words">{preview}</span>
            ) : (
              <span className="text-muted-foreground">Write the prompt for this step…</span>
            )}
          </button>
        </DialogTrigger>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Prompt — {step.name}</DialogTitle>
            <DialogDescription>
              What this step asks of its harness. It runs as written, so say the whole thing.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={`Prompt for ${step.name}`}
            className="min-h-[24rem] font-mono text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                if (draft !== step.promptTemplate) save(draft);
                setOpen(false);
              }}
            >
              Save prompt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A Step's exits, on its right edge. One in the middle for a Step that goes to its successor;
 * two — labelled, because the palette is greyscale and a colour would be the only cue — for a
 * Step that branches. The ids are what `stepEdges` names as `sourceHandle`.
 */
function StepExits({ branching }: { branching: boolean }) {
  if (!branching) {
    return (
      <Handle
        id="next"
        type="source"
        position={Position.Right}
        style={{ top: MAIN_LINE_TOP }}
        className={HANDLE}
        // The rank order is not a thing to drag elsewhere; only a branch's exits are.
        isConnectable={false}
      />
    );
  }
  return (
    <>
      <Handle
        id="then"
        type="source"
        position={Position.Right}
        style={{ top: THEN_HANDLE_TOP }}
        className={`${HANDLE} !bg-foreground`}
      />
      <ExitChip top={THEN_HANDLE_TOP}>yes</ExitChip>
      <Handle
        id="else"
        type="source"
        position={Position.Right}
        style={{ top: ELSE_HANDLE_TOP }}
        className={HANDLE}
      />
      <ExitChip top={ELSE_HANDLE_TOP}>no</ExitChip>
    </>
  );
}

/**
 * A pair of handlers that keep a thing open while the pointer is over *either* of two elements.
 *
 * The node toolbar is portalled outside the card it belongs to, so the pointer necessarily
 * leaves the card to reach it. Closing on that `pointerleave` makes the toolbar unclickable —
 * it vanishes in the gap. A short linger, cancelled by the toolbar's own `pointerenter`, is the
 * whole fix; the same handlers on both elements are what makes them one hover target.
 */
function useLingeringHover(): {
  open: boolean;
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  };
} {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), TOOLBAR_LINGER_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // `onFocus`/`onBlur` bubble in React, so on a wrapper they are focus-*within*: the toolbar is
  // reachable by keyboard as soon as anything inside the card has the caret.
  return {
    open,
    handlers: { onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide },
  };
}

/**
 * What a Step is, without any of the controls that change it — the node below `COMPACT_ZOOM`.
 *
 * Every fact here is one the pipeline is read for: which harness, what gate, does it branch, is
 * it in trouble. The name is text rather than the input it becomes when zoomed in, because at
 * this size a caret is not something anyone is aiming for.
 */
function StepSummary({
  step,
  ordinal,
  dotColor,
  harness,
  problems,
}: {
  step: WorkflowStepDto;
  ordinal: number;
  dotColor: string;
  harness: string;
  problems: readonly WorkflowGraphProblem["kind"][];
}) {
  return (
    <div
      className="flex flex-col gap-2 px-3 py-2.5"
      /* The card's middle is the axis, so a compact card needs no minimum — except a branching
         one, whose `No` exit hangs below that middle and has to land on the card. */
      style={step.branch ? { minHeight: BRANCHING_MIN_HEIGHT } : undefined}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="text-muted-foreground text-xs tabular-nums">{ordinal}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{step.name}</span>
        {step.branch && (
          <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
      <p className="truncate font-mono text-muted-foreground text-xs">{harness}</p>
      <p className="text-2xs text-muted-foreground">
        {GATE_LABELS[step.gate]} · {ADVANCE_LABELS[step.advanceOn]}
      </p>
      {problems.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs" role="alert">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          {problems.length === 1 ? "1 problem" : `${problems.length} problems`}
        </p>
      )}
    </div>
  );
}

function StepNodeView({ data }: NodeProps<StepNode>) {
  const { step, index, dotColor, libraries, problems, profiles, siblings, onAddAfter, adding } =
    data;
  const utils = trpc.useUtils();
  const refresh = () => utils.workflow.get.invalidate({ id: step.workflowId });
  const update = trpc.workflow.updateStep.useMutation({ onSuccess: refresh });
  const remove = trpc.workflow.deleteStep.useMutation({ onSuccess: refresh });
  /*
   * The card being removed leaves *visibly* — dims and shrinks for a beat — before the row is
   * asked to close up. Without it the deletion was instant, the neighbours slid into the gap
   * and took its ordinal, and what the eye registered was the last card vanishing: reported as
   * "the trash deletes the wrong node". The beat is the exit's length, not a debounce.
   */
  const [leaving, setLeaving] = useState(false);
  const removeAfterExit = () => {
    setLeaving(true);
    window.setTimeout(() => remove.mutate({ stepId: step.id }), EXIT_MS);
  };
  const [name, setName] = useState(step.name);
  // A refreshed list carries an edit made elsewhere; the local draft yields to it.
  useEffect(() => setName(step.name), [step.name]);

  /*
   * Contextual zoom. A boolean selector rather than the zoom itself: React Flow re-runs this on
   * every wheel tick, and a node that re-rendered on each one would be paying for a fact that
   * changes twice a session.
   */
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM);
  const tools = useLingeringHover();

  const ordinal = index + 1;
  const harness = profiles.find((p) => p.id === step.agentProfileId)?.name ?? "…";
  const successorId = siblings[siblings.findIndex((s) => s.id === step.id) + 1]?.id ?? null;

  return (
    <div
      className={`rounded-xl border bg-card text-card-foreground shadow-sm transition-[box-shadow,opacity,transform] duration-200 hover:shadow-md ${problems.length > 0 ? "border-dashed" : ""} ${leaving ? "pointer-events-none scale-95 opacity-30" : ""}`}
      style={{ width: STEP_NODE_WIDTH }}
      data-step-id={step.id}
      {...tools.handlers}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ top: MAIN_LINE_TOP }}
        className={HANDLE}
      />
      <StepExits branching={step.branch !== null} />

      {/*
       * The two acts that are *about* the Step rather than fields of it — removing it, and
       * making it branch — live on a toolbar beside the card instead of in its header and its
       * last row. A `NodeToolbar` is drawn outside the viewport transform, so it stays legible
       * at any zoom, which is also what lets a compact node still be deleted.
       */}
      <NodeToolbar isVisible={tools.open && !leaving} position={Position.Top} offset={8}>
        <div
          className="flex items-center gap-1 rounded-lg border bg-card p-1 shadow-md"
          {...tools.handlers}
        >
          {!step.branch && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              aria-label={`Branch ${step.name} on a condition`}
              onClick={() => update.mutate({ stepId: step.id, branch: defaultBranch(successorId) })}
            >
              <GitBranch aria-hidden />
              Branch
            </Button>
          )}
          <ConfirmAction
            title={`Remove “${step.name}”?`}
            description="Tasks already parked on this step keep it — the removal is refused until they move on."
            confirmLabel="Remove step"
            onConfirm={removeAfterExit}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                aria-label={`Remove ${step.name}`}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            }
          />
        </div>
      </NodeToolbar>

      {compact ? (
        <StepSummary
          step={step}
          ordinal={ordinal}
          dotColor={dotColor}
          harness={harness}
          problems={problems}
        />
      ) : (
        <>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            {/* The dot is a second cue beside the ordinal, never the only one (WCAG 1.4.1). */}
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: dotColor }}
            />
            <span className="text-muted-foreground text-xs tabular-nums">{ordinal}</span>
            <Input
              aria-label={`Name of step ${ordinal}`}
              className={`${FIELD} h-7 flex-1 border-0 bg-transparent px-1 font-medium text-sm shadow-none focus-visible:ring-1`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                const trimmed = name.trim();
                if (!trimmed) return setName(step.name);
                if (trimmed !== step.name) update.mutate({ stepId: step.id, name: trimmed });
              }}
            />
          </div>

          {/* Said on the node, in words, so the reason is in sight of the branch that caused it.
          A dashed border is the second cue; the palette has no colour to spend on a third. */}
          {problems.length > 0 && (
            <ul className="space-y-1 border-b px-3 py-2" aria-label={`Problems with ${step.name}`}>
              {problems.map((kind) => (
                <li key={kind} className="flex items-start gap-1.5 text-xs" role="alert">
                  <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                  <span>{PROBLEM_TEXT[kind]}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2.5 px-3 py-2.5">
            <div className="grid gap-1.5">
              <Label htmlFor={`step-harness-${step.id}`} className="text-xs">
                Harness profile
              </Label>
              <Select
                value={step.agentProfileId}
                onValueChange={(v) => update.mutate({ stepId: step.id, agentProfileId: v })}
              >
                <SelectTrigger
                  id={`step-harness-${step.id}`}
                  className={`${FIELD} h-7 w-full text-xs`}
                >
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
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`step-gate-${step.id}`} className="text-xs">
                  Gate
                </Label>
                <Select
                  value={step.gate}
                  onValueChange={(v) =>
                    update.mutate({ stepId: step.id, gate: v as WorkflowStepGate })
                  }
                >
                  <SelectTrigger
                    id={`step-gate-${step.id}`}
                    className={`${FIELD} h-7 w-full text-xs`}
                  >
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
              <div className="grid gap-1.5">
                <Label htmlFor={`step-advance-${step.id}`} className="text-xs">
                  Finished when
                </Label>
                <Select
                  value={step.advanceOn}
                  onValueChange={(v) =>
                    update.mutate({ stepId: step.id, advanceOn: v as WorkflowAdvanceOn })
                  }
                >
                  <SelectTrigger
                    id={`step-advance-${step.id}`}
                    className={`${FIELD} h-7 w-full text-xs`}
                  >
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
            </div>
            <PromptField
              step={step}
              save={(promptTemplate) => update.mutate({ stepId: step.id, promptTemplate })}
            />
            <LoadsFields
              step={step}
              libraries={libraries}
              save={(patch) => update.mutate({ stepId: step.id, ...patch })}
            />
            <BranchFields
              step={step}
              siblings={siblings}
              save={(branch) => update.mutate({ stepId: step.id, branch })}
            />
            {(update.error || remove.error) && (
              <p className="font-mono text-state-failed text-xs" role="alert">
                {(update.error ?? remove.error)?.message}
              </p>
            )}
          </div>
        </>
      )}

      <AddInGap
        label={`Add a step after ${step.name}`}
        disabled={adding}
        onClick={() => onAddAfter(step.id)}
      />
    </div>
  );
}

/**
 * Where the pipeline starts and where it ends. Not Steps: nothing runs on either, so nothing on
 * either is editable, and there is exactly one of each because neither is a row that could be
 * inserted twice — see `START_NODE_ID` / `END_NODE_ID`.
 */
const TERMINAL =
  "rounded-full border px-3 py-1 font-medium text-xs uppercase leading-4 tracking-[0.14em]";

/**
 * The start is filled and the end is outlined: the one place the palette's single ink is spent
 * on a node, because "where does this begin" is the first thing a reader looks for. The `+` in
 * the start's gap is how a Step is put *before* the first one — the only insert the Steps' own
 * `+` cannot express.
 */
function StartNodeView({ data }: NodeProps<StartNode>) {
  return (
    <div
      className={`${TERMINAL} relative border-foreground bg-foreground text-background`}
      style={{ width: START_NODE_WIDTH, textAlign: "center" }}
    >
      Start
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE} !border-foreground`}
        isConnectable={false}
      />
      <AddInGap
        label="Add a step at the start"
        disabled={data.adding}
        onClick={data.onAddAtStart}
        top="50%"
      />
    </div>
  );
}

function EndNodeView() {
  return (
    <div className={`${TERMINAL} bg-card text-muted-foreground`}>
      <Handle type="target" position={Position.Left} className={HANDLE} />
      End
    </div>
  );
}

/**
 * The line drawn while a branch exit is being dragged (React Flow's `connectionLineComponent`).
 *
 * It has three things to say and says each in a different place: *which exit* is in hand (the
 * chip at the origin), *where it would land* (the reticle at the pointer, snapped to a handle
 * when one is in reach), and *whether that is allowed* (the whole line's weight — a valid target
 * pulls the line solid and names itself beside the reticle; an invalid one dims it and crosses
 * the reticle out). The glow is a blurred copy of the same path, so it cannot drift from it.
 */
function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromHandle,
  toNode,
  connectionStatus,
}: ConnectionLineComponentProps<CanvasNode>) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: Position.Right,
    targetX: toX,
    targetY: toY,
    targetPosition: Position.Left,
  });
  const status = connectionStatus ?? "pending";
  const exit = fromHandle.id === "else" ? "no" : "yes";
  const landing =
    status === "valid" && toNode
      ? toNode.type === "end"
        ? "End"
        : ((toNode.data as Partial<StepNodeData>).step?.name ?? null)
      : null;

  return (
    <g className={`workflow-connection workflow-connection--${status}`}>
      <defs>
        <filter id="workflow-connection-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <path
        d={path}
        className="workflow-connection__glow"
        filter="url(#workflow-connection-glow)"
      />
      <path d={path} className="workflow-connection__line" />
      <circle r={3} className="workflow-connection__pulse">
        <animateMotion dur="0.9s" repeatCount="indefinite" path={path} />
      </circle>
      <g transform={`translate(${fromX + 10} ${fromY - 18})`}>
        <rect
          x={0}
          y={-9}
          width={exit.length * 7 + 10}
          height={14}
          rx={7}
          className="workflow-connection__chip"
        />
        <text x={5} y={1} className="workflow-connection__label">
          {exit}
        </text>
      </g>
      <g transform={`translate(${toX} ${toY})`} className="workflow-connection__reticle">
        <circle r={13} className="workflow-connection__ring" />
        <circle r={4} className="workflow-connection__core" />
        {status === "invalid" && (
          <path d="M-4 -4 L4 4 M4 -4 L-4 4" className="workflow-connection__cross" />
        )}
      </g>
      {landing && (
        <text x={toX + 20} y={toY + 4} className="workflow-connection__label">
          → {landing}
        </text>
      )}
    </g>
  );
}

type StepEdgeData = { kind: StepEdgeKind; adjacent: boolean };
type StepEdge = Edge<StepEdgeData, "step">;

/** How far a routed edge leaves the row by, above or below the tallest card. */
const ROUTE_CLEARANCE = 40;
/** How far a routed edge travels straight out of its handle before turning. */
const ROUTE_STUB = STEP_NODE_GAP / 4;
/** The corner radius of every edge, routed or not. */
const EDGE_RADIUS = 20;

/** How far along a lane its badge sits, measured back from the end the edge arrives at. */
const LANE_LABEL_INSET = 26;
/** How long a removed card takes to leave — the transition's length, and the delete's delay. */
const EXIT_MS = 200;

/**
 * The edge between two Steps: a dashed line that flows in the direction the pipeline runs, with
 * a dot travelling it. Pure SVG animation — nothing ticks in React.
 *
 * An adjacent edge crosses the gap. Any other edge — a `Yes` that skips a Step, a `No` that
 * goes back two — cannot, because every Step sits on the same row and a smooth step between
 * two points at the same height is a line straight through whatever is between them. Those are
 * routed *around* the row instead: `then` over the top, `else` underneath, which also happens to
 * be the side each exit is on. The row's height is read from the measured nodes, so a card that
 * grew a branch form does not get an edge drawn through its lower half.
 */
function StepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
}: EdgeProps<StepEdge>) {
  const nodes = useNodes();
  const kind = data?.kind ?? "next";
  const routed = data?.adjacent === false;

  let path: string;
  // Where a routed edge's label sits: the middle of its long run, which is the one stretch of it
  // that is clear of every node.
  let label: { x: number; y: number } | null = null;
  if (!routed) {
    [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition: Position.Right,
      targetX,
      targetY,
      targetPosition: Position.Left,
      borderRadius: EDGE_RADIUS,
    });
  } else {
    // A node's position names its middle, so the row reaches half a card either side of the
    // axis — and a `then` lane at a fixed negative y would have run through the top of every card.
    const half = (n: (typeof nodes)[number]) => (n.measured?.height ?? 0) / 2;
    const rowTop = Math.min(MAIN_LINE_Y, ...nodes.map((n) => n.position.y - half(n)));
    const rowBottom = Math.max(MAIN_LINE_Y, ...nodes.map((n) => n.position.y + half(n)));
    const lane = kind === "else" ? rowBottom + ROUTE_CLEARANCE : rowTop - ROUTE_CLEARANCE;
    const out = sourceX + ROUTE_STUB;
    const back = targetX - ROUTE_STUB;
    path = roundedPath(
      [
        { x: sourceX, y: sourceY },
        { x: out, y: sourceY },
        { x: out, y: lane },
        { x: back, y: lane },
        { x: back, y: targetY },
        { x: targetX, y: targetY },
      ],
      EDGE_RADIUS,
    );
    /*
     * The lane badge goes at the *arriving* end of the run, not its middle.
     *
     * The middle of a run that spans four cards is above whichever card happens to be halfway
     * along it, and says nothing about where the edge came from or where it is going — the one
     * question a line travelling around the row raises. The leaving end is already named, by the
     * chip on the node's own edge, so this is the end worth spending a badge on: a `yes` that
     * loops back to `Implement` now reads `yes` where it leaves and `yes` where it lands, and can
     * be traced from either. Clamped to the midpoint when the run is too short to inset into.
     */
    if (kind === "then" || kind === "else") {
      label = { x: laneLabelX(out, back, LANE_LABEL_INSET), y: lane };
    }
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={kind === "else" ? "workflow-edge workflow-edge-else" : "workflow-edge"}
        {...(markerEnd ? { markerEnd } : {})}
      />
      <circle r={3} className="workflow-edge-pulse">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
      {label && (
        <EdgeLabelRenderer>
          <span
            aria-hidden
            className={`${CHIP} absolute`}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {kind === "then" ? "yes" : "no"}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { step: StepNodeView, start: StartNodeView, end: EndNodeView };
const EDGE_TYPES = { step: StepEdge };

function Canvas({ workflow }: { workflow: WorkflowWithStepsDto }) {
  const utils = trpc.useUtils();
  const profiles = trpc.profile.agent.list.useQuery({ ...WHOLE_PAGE });
  // The libraries a Step can name (spec F24). Off — the flag, or a failed read — is null, and
  // the node then shows no `Loads` block at all rather than an empty one.
  const mcpLibrary = trpc.library.mcp.list.useQuery({}, { retry: false });
  const skillLibrary = trpc.library.skill.list.useQuery({}, { retry: false });
  const libraries = useMemo<Libraries>(
    () =>
      mcpLibrary.data && skillLibrary.data
        ? { mcp: mcpLibrary.data, skills: skillLibrary.data }
        : null,
    [mcpLibrary.data, skillLibrary.data],
  );
  // Memoized, and the mutation *functions* below are what the callbacks close over rather than
  // the mutation objects: `layout` feeds `setNodes` from an effect, so anything in its dependency
  // chain that is a fresh value on every render is a render loop, not a stale closure.
  const options = useMemo<readonly Profile[]>(
    () => profiles.data?.items ?? NO_PROFILES,
    [profiles.data],
  );

  const refresh = () => {
    utils.workflow.get.invalidate({ id: workflow.id });
    utils.workflow.list.invalidate();
  };
  const add = trpc.workflow.addStep.useMutation({ onSuccess: refresh });
  const reorder = trpc.workflow.reorderStep.useMutation({ onSuccess: refresh });
  const retarget = trpc.workflow.updateStep.useMutation({ onSuccess: refresh });
  const { mutate: addStep, isPending: adding, error: addError } = add;
  const { mutate: reorderStep, error: reorderError } = reorder;
  const { mutate: retargetStep, error: retargetError } = retarget;

  /**
   * A branch exit dropped on a node: the same `updateStep` the node's own selects send, with the
   * whole branch, because the server checks the two targets together. Read through
   * `branchRetarget` so the drag and the line agree on what is allowed.
   */
  const onConnect = useCallback(
    (connection: Connection) => {
      const move = branchRetarget(connection);
      const step = move ? workflow.steps.find((entry) => entry.id === move.stepId) : undefined;
      if (!move || !step?.branch) return;
      retargetStep({
        stepId: step.id,
        branch:
          move.exit === "then"
            ? { ...step.branch, thenStepId: move.targetStepId }
            : { ...step.branch, elseStepId: move.targetStepId },
      });
    },
    [retargetStep, workflow.steps],
  );
  // Class on the canvas while an exit is in hand, so every target handle can say it is one.
  const [connecting, setConnecting] = useState(false);

  /**
   * The `+` asks nothing: the new Step takes the first Harness Profile in the catalog and a
   * numbered name, both changed in place on the node it becomes. A form here would be the
   * add-step card the canvas exists to get rid of. Refused, not guessed, when the catalog is
   * empty — a Step must name a harness, and there is none to name.
   */
  const firstProfile = options[0];
  // Held as one flag rather than two, because the node has one thing to do with it — dim the
  // `+` — and a click that silently did nothing while the catalog loads was how the gap read.
  const cannotAdd = adding || !firstProfile;
  const addAfter = useCallback(
    // A Step id to insert after it; null to insert at the head. An empty pipeline sends neither,
    // because its head and its tail are the same place and "append" is the plainer request.
    (afterStepId: string | null) => {
      if (!firstProfile) return;
      addStep({
        workflowId: workflow.id,
        name: nextStepName(workflow.steps),
        agentProfileId: firstProfile.id,
        ...(afterStepId !== null || workflow.steps.length > 0 ? { afterStepId } : {}),
      });
    },
    [addStep, firstProfile, workflow.id, workflow.steps],
  );

  const layout = useMemo<CanvasNode[]>(() => {
    const placed = placeSteps(workflow.steps);
    const siblings = placed.map(({ step }) => ({ id: step.id, name: step.name }));
    const problems = validateWorkflowGraph(workflow.steps);
    const dots = stepDotColors(workflow.steps);
    const stepNodes: CanvasNode[] = placed.map(({ step, index, x, y }) => ({
      id: step.id,
      type: "step",
      position: { x, y },
      data: {
        step,
        index,
        libraries,
        dotColor: dots.get(step.id) ?? "var(--muted-foreground)",
        problems: problems.filter((p) => p.stepId === step.id).map((p) => p.kind),
        profiles: options,
        siblings,
        onAddAfter: addAfter,
        adding: cannotAdd,
      },
    }));
    // The start and the end are only worth drawing once there is something between them; an
    // empty canvas has its own message. Neither is draggable — neither is a Step, so neither
    // has a rank a drag could state.
    if (placed.length === 0) return stepNodes;
    const start: StartNode = {
      id: START_NODE_ID,
      type: "start",
      position: startNodePosition(),
      data: { onAddAtStart: () => addAfter(null), adding: cannotAdd },
      draggable: false,
      selectable: false,
    };
    const end: EndNode = {
      id: END_NODE_ID,
      type: "end",
      position: endNodePosition(workflow.steps),
      data: {},
      draggable: false,
      selectable: false,
    };
    return [start, ...stepNodes, end];
  }, [workflow.steps, options, libraries, addAfter, cannotAdd]);
  const edges = useMemo<StepEdge[]>(() => {
    const names = new Map(workflow.steps.map((step) => [step.id, step.name]));
    const nameOf = (id: string) => (id === END_NODE_ID ? "the end" : (names.get(id) ?? id));
    // A lookup table would need a key named `then`, which the linter reads as a thenable.
    const exit = (kind: StepEdgeKind) =>
      kind === "then" ? "If yes" : kind === "else" ? "If no" : "Then";
    return stepEdges(workflow.steps).map((spec) => ({
      id: spec.id,
      source: spec.source,
      // The start pill has one unnamed handle; every Step exit is named after its kind.
      ...(spec.kind === "start" ? {} : { sourceHandle: spec.kind }),
      target: spec.target,
      type: "step",
      markerEnd: ARROW,
      data: { kind: spec.kind, adjacent: spec.adjacent },
      ariaLabel:
        spec.kind === "start"
          ? `Start → ${nameOf(spec.target)}`
          : `${exit(spec.kind)}: ${nameOf(spec.source)} → ${nameOf(spec.target)}`,
    }));
  }, [workflow.steps]);

  const [nodes, setNodes, applyChanges] = useNodesState<CanvasNode>(layout);
  useEffect(() => setNodes(layout), [layout, setNodes]);

  /*
   * Fit on every change of the *region*, not once at mount.
   *
   * React Flow's own `fitView` prop fires once, against whatever size the container has at that
   * moment — and that moment is wrong here by design: the secondary sidebar claims its slot in an
   * effect, so it mounts one commit *after* the canvas, and the pipeline was centred for a `main`
   * 18rem wider than the one it ended up in, with the last Step clipped under the panel. The same
   * one-shot also ignored the panel's toggle and a window resize. The store already measures the
   * container with a ResizeObserver; fitting again whenever that measurement moves is what keeps
   * the graph in the region it is actually in. Also on the Step count, so a `+` brings the node it
   * added into view instead of leaving it off the right edge. Not on the Steps themselves: a
   * rename refreshes the list too, and re-fitting on that would yank the viewport out from under
   * an operator mid-edit.
   */
  // `getNodesBounds` off the instance rather than the standalone import: the instance's knows
  // the canvas's `nodeOrigin`, and a bounds computed as if a position named a card's top would
  // be half a card out — which is exactly the pin this uses it for.
  const { fitView, getZoom, getNodes, getNodesBounds, setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const stepCount = workflow.steps.length;
  useEffect(() => {
    // Unmeasured yet, or nothing to fit: a fit against a 0×0 region is a viewport at infinity.
    if (width === 0 || height === 0 || stepCount === 0) return;
    let cancelled = false;
    void fitView(FIT_VIEW).then((fitted) => {
      if (!fitted || cancelled) return;
      // A pipeline too long to fit at the readable minimum is shown from its *start*, not from
      // its middle: centring it clips both ends, and the one a reader needs first is the left.
      const zoom = getZoom();
      if (zoom > FIT_VIEW.minZoom + 1e-6) return;
      const bounds = getNodesBounds(getNodes());
      const margin = 24;
      void setViewport({
        x: margin - bounds.x * zoom,
        y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
        zoom,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fitView, getZoom, getNodes, getNodesBounds, setViewport, width, height, stepCount]);

  // A drag is horizontal: the order is the only thing a node can say about itself.
  const onNodesChange: OnNodesChange<CanvasNode> = useCallback(
    (changes) =>
      applyChanges(
        changes.map((change) =>
          change.type === "position" && change.position
            ? // A drag states a rank and nothing else, so only x is taken from it: the node
              // stays on the axis it is strung on.
              { ...change, position: { x: change.position.x, y: MAIN_LINE_Y } }
            : change,
        ),
      ),
    [applyChanges],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: CanvasNode) => {
      const move = reorderFromDrop(workflow.steps, node.id, node.position.x);
      if (move) reorderStep(move);
      // Back to the laid-out place either way: the refreshed list is what moves it for real.
      setNodes(layout);
    },
    [workflow.steps, reorderStep, layout, setNodes],
  );

  const error = addError ?? reorderError ?? retargetError;

  return (
    // Full-bleed: the canvas *is* the page. It was a bordered 36rem box in a padded column, so a
    // six-step pipeline was read through a letterbox while the viewport had room for all of it.
    // No border and no radius either — there is nothing left beside it for a frame to separate it
    // from, and the shell's own edges already do that job.
    <section
      className={`workflow-canvas h-full w-full overflow-hidden ${connecting ? "workflow-canvas--connecting" : ""}`}
      aria-label={`Steps of ${workflow.name}`}
    >
      <ReactFlow<CanvasNode, StepEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        // A position is a node's left edge and its vertical middle, which is what puts the start
        // pill, every card and the end pill on one line however tall each of them is.
        nodeOrigin={NODE_ORIGIN}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        // Only a branch's `Yes`/`No` exits are connectable (see the handles); the drop is judged
        // by the same function that writes it, so the line and the write cannot disagree.
        isValidConnection={(connection) => branchRetarget(connection) !== null}
        onConnect={onConnect}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        connectionLineComponent={ConnectionLine}
        connectionRadius={40}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
        {/*
         * Worth its corner from about five Steps on, which is where a pipeline stops fitting at a
         * readable zoom and the canvas starts being something you are *lost* in. Each Step is
         * drawn in the colour of its own dot, so the map is the same list the outline and the
         * cards are; pannable and zoomable, so it is a control and not only a picture.
         */}
        {workflow.steps.length > 3 && (
          <MiniMap<CanvasNode>
            pannable
            zoomable
            ariaLabel={`Overview of ${workflow.name}`}
            nodeColor={(node) =>
              node.type === "step" ? node.data.dotColor : "var(--muted-foreground)"
            }
            nodeStrokeWidth={0}
            className="rounded-lg border shadow-sm"
          />
        )}
        {/* The pipeline's name floats on the canvas instead of sitting in a header strip: a band
            above a full-bleed canvas would take back the vertical space going full-bleed just
            won. The WIP badge rides with it — the Monitor half of F03 (a run's live position on
            this graph) is not built yet, and the badge says so before a click does. */}
        <Panel
          position="top-left"
          className="flex items-center gap-2 rounded-lg border bg-card/85 px-2.5 py-1.5 shadow-sm backdrop-blur"
        >
          <span className="font-medium text-sm">{workflow.name}</span>
          <Badge variant="outline" className="text-2xs">
            WIP
          </Badge>
        </Panel>
        {workflow.steps.length === 0 && (
          <Panel position="top-center" className="flex flex-col items-center gap-2 pt-16">
            <p className="text-muted-foreground text-sm">
              No steps yet. A workflow with no steps cannot be attached to a task.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={!firstProfile || adding}
              onClick={() => addAfter(null)}
            >
              <Plus aria-hidden />
              Add the first step
            </Button>
            {!profiles.isLoading && !firstProfile && (
              <p className="text-muted-foreground text-xs">
                Create a harness profile first — a step has to name one.
              </p>
            )}
          </Panel>
        )}
        {error && (
          <Panel position="bottom-center">
            <p className="font-mono text-state-failed text-xs" role="alert">
              {error.message}
            </p>
          </Panel>
        )}
      </ReactFlow>
    </section>
  );
}

export function WorkflowCanvas({ workflow }: { workflow: WorkflowWithStepsDto }) {
  return (
    <ReactFlowProvider>
      <Canvas workflow={workflow} />
    </ReactFlowProvider>
  );
}
