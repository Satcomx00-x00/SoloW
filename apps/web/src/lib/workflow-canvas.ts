import type { WorkflowStepDto } from "@solow/contracts";
import { sortSteps, stepExits } from "@solow/core";

/**
 * The geometry and the arithmetic behind the Workflow canvas (F03 FR-1/FR-4, Decision 0007).
 *
 * Nothing in this module is a component or touches React Flow: it is the part of the canvas a
 * test can hold still. The surface itself only ever asks two questions — "where does each Step
 * sit" and "the operator let go of a node here, what move is that" — and both are answered from
 * the Step list, which is the same list the server orders by rank. Positions are therefore
 * derived and never stored: a Step's place on the canvas *is* its rank, so there is no second
 * layout to drift from the one the run loop walks.
 */

/** One Step node's box. The prompt textarea is what sets the width; the gap is for the `+`. */
export const STEP_NODE_WIDTH = 320;
export const STEP_NODE_GAP = 96;

/**
 * The two nodes that are not Steps: where the pipeline starts and where it ends. One of each,
 * by construction rather than by rule — neither is a row anywhere, so there is nothing to add a
 * second of. The start *is* the first Step in rank order and the end *is* a null target; the two
 * pills draw those facts so an edge has somewhere to come from and somewhere to point at.
 */
export const START_NODE_ID = "start";
export const END_NODE_ID = "end";

/**
 * The pipeline's axis: the one horizontal line every node is centred on, from the start pill to
 * the end pill. Zero, because it is the origin the whole row is hung from.
 *
 * It used to be a fixed 112px measured down from the top of each card, with every card
 * top-aligned at y = 0. That kept the *line* straight while hanging the nodes off it: an edge
 * entered a tall card near its top and a short one near its bottom, and the 24px start and end
 * pills sat wherever 112px happened to fall on their neighbours. Centring is what makes the row
 * read as one line with things strung along it — which is also why `placeSteps` now takes the
 * measured heights: a node's `y` is a fact about how tall it turned out to be, and only the DOM
 * knows that.
 *
 * Every entry, the plain exit and the `Yes` exit sit on this line; the `No` exit hangs below it.
 */
export const MAIN_LINE_Y = 0;

/**
 * What a node's position *means*: its left edge, and its vertical **middle** (React Flow's
 * `nodeOrigin`). This one number is what centres the row.
 *
 * The alternative was to keep the default top-left origin and subtract half of each card's
 * measured height — which works, but makes the layout depend on a measurement that only exists
 * one frame after the render that needs it, and makes every card that grows a branch form
 * recompute the whole row. Telling React Flow where a position points is the same statement made
 * once, and its own bounds arithmetic — `fitView`, the minimap, the viewport — accounts for it.
 */
export const NODE_ORIGIN: [number, number] = [0, 0.5];

/** The pills at the two ends sit on the axis like everything else does. */
export const END_NODE_Y = MAIN_LINE_Y;
/** How wide the start pill is, so it can sit one gap before the first Step. */
export const START_NODE_WIDTH = 64;

export function startNodePosition(): { x: number; y: number } {
  return { x: -(STEP_NODE_GAP + START_NODE_WIDTH), y: END_NODE_Y };
}

export function endNodePosition(steps: readonly WorkflowStepDto[]): { x: number; y: number } {
  return { x: steps.length * (STEP_NODE_WIDTH + STEP_NODE_GAP), y: END_NODE_Y };
}

/**
 * Which exit of a Step an edge leaves by. `next` is the rank successor — the only exit a Step
 * without a branch has. `then` and `else` are the two exits a branching Step has instead.
 * `start` is the one edge that leaves no Step: from the start pill into the first Step.
 */
export type StepEdgeKind = "start" | "next" | "then" | "else";

export interface StepEdgeSpec {
  id: string;
  /** A Step id, or `START_NODE_ID`. */
  source: string;
  /** A Step id, or `END_NODE_ID`. */
  target: string;
  kind: StepEdgeKind;
  /**
   * Does the edge reach the Step immediately after its source in rank order? An adjacent edge
   * is drawn straight across the gap; any other one — a skip forward, or a jump back — has to be
   * routed around the row, because every Step sits on the same line.
   */
  adjacent: boolean;
}

/**
 * The edges of the graph, derived from the Step list and stored nowhere — the same rule as the
 * positions. The exits themselves come from `stepExits` in `@solow/core`, which is the rule the
 * run loop follows; this only decides how each one is drawn. Which is to say: the edges *are*
 * the next-Step rule, and there is no edge the operator could draw that is not one of them.
 */
export function stepEdges(steps: readonly WorkflowStepDto[]): StepEdgeSpec[] {
  const ordered = sortSteps(steps);
  const exits = stepExits(ordered);
  const first = ordered[0];
  const entry: StepEdgeSpec[] = first
    ? [{ id: "start:next", source: START_NODE_ID, target: first.id, kind: "start", adjacent: true }]
    : [];
  return [
    ...entry,
    ...ordered.flatMap((step, index) => {
      const successor = ordered[index + 1]?.id ?? END_NODE_ID;
      return (exits.get(step.id) ?? []).map((exit): StepEdgeSpec => {
        const target = exit.stepId ?? END_NODE_ID;
        return {
          id: `${step.id}:${exit.kind}`,
          source: step.id,
          target,
          kind: exit.kind,
          adjacent: target === successor,
        };
      });
    }),
  ];
}

export interface StepPlacement {
  step: WorkflowStepDto;
  index: number;
  x: number;
  y: number;
}

/**
 * Left to right, in rank order, one row, every node on the axis. A linear pipeline reads the way
 * it runs, and — because a position points at a node's middle (`NODE_ORIGIN`) — a card that is
 * twice as tall as its neighbour still lines up with it.
 */
export function placeSteps(steps: readonly WorkflowStepDto[]): StepPlacement[] {
  return sortSteps(steps).map((step, index) => ({
    step,
    index,
    x: index * (STEP_NODE_WIDTH + STEP_NODE_GAP),
    y: MAIN_LINE_Y,
  }));
}

/**
 * Where a badge sits on an edge routed around the row: at the end the edge *arrives* at.
 *
 * `from` is where the run leaves the source's side, `to` where it turns back down into its
 * target — so for a backward edge `to` is the smaller of the two and the inset points the other
 * way. The middle of a run spanning four cards is above whichever card happens to be halfway
 * along it and says nothing about either end; the leaving end is already named by the chip on the
 * node's own edge, which leaves the arriving end as the one worth spending a badge on.
 *
 * Clamped to the midpoint when the run is shorter than twice the inset, so a badge never lands
 * past the corner it was measured back from.
 */
export function laneLabelX(from: number, to: number, inset: number): number {
  const towardSource = Math.sign(from - to) || 1;
  return to + towardSource * Math.min(inset, Math.abs(from - to) / 2);
}

export interface StepMove {
  stepId: string;
  afterStepId: string | null;
  beforeStepId: string | null;
}

/**
 * What a drop means, stated as the neighbour pair `workflow.reorderStep` takes.
 *
 * The dragged node's left edge is compared with the *laid-out* left edge of every other node —
 * the others never moved, so their layout position is where the operator saw them. The node
 * lands after every neighbour it was dropped to the right of, which is what makes "swap Step 1
 * with Step 2" a drag of Step 1 past Step 2's left edge and nothing more precise.
 *
 * Null when the drop lands the node where it already was, so a nudge sends nothing and the
 * canvas simply snaps the node back. The pair rather than a position, for the reason the
 * contract gives: a position is a claim about the whole list, a pair can be checked.
 */
export function reorderFromDrop(
  steps: readonly WorkflowStepDto[],
  draggedId: string,
  droppedX: number,
): StepMove | null {
  const placed = placeSteps(steps);
  const from = placed.findIndex((entry) => entry.step.id === draggedId);
  if (from === -1) return null;

  const others = placed.filter((entry) => entry.step.id !== draggedId);
  const to = others.filter((entry) => entry.x < droppedX).length;
  if (to === from) return null;

  return {
    stepId: draggedId,
    afterStepId: others[to - 1]?.step.id ?? null,
    beforeStepId: others[to]?.step.id ?? null,
  };
}

/**
 * The hue of a Step's dot, from its id and nothing else — so it is the same on every render,
 * every reload and, above all, after every insert and delete, without a column to store it in.
 *
 * It used to follow the ordinal, spaced by the golden angle so neighbours were always far apart
 * on the wheel. That made a *deletion* unreadable: the cards to the right slid into the gap and
 * took over the deleted card's ordinal and colour, so the card that appeared to vanish was the
 * last one, not the one whose trash was pressed — reported as exactly that bug. Identity has to
 * survive the row changing shape; distinctness is second, and twelve hues 30° apart keep two
 * neighbours from sharing one in all but one case in twelve. The dot is a second cue beside the
 * ordinal, never the only one (WCAG 1.4.1).
 */
export function stepHue(id: string): number {
  // FNV-1a: cheap, stable, and spreads similar ids (uuids differ in a few characters) well.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 12) * 30;
}

/** A dot colour that reads on both surfaces: mid lightness, enough chroma to be a colour. */
export function stepDotColor(id: string): string {
  return `oklch(0.72 0.17 ${stepHue(id)})`;
}

/**
 * Every Step's dot colour, with no two siblings alike (up to twelve of them).
 *
 * `stepHue` alone is stable but blind to its neighbours, and the one-in-twelve collision landed
 * on two adjacent Steps the first time it was measured. Collisions are resolved here, among the
 * Steps that actually share a canvas: in creation order, a Step whose hue is already taken moves
 * to the next free one. Creation order rather than rank, so a *reorder* changes no colour; and
 * the earlier Step keeps its base hue, so an insert changes no existing colour either. The one
 * event that can still move a colour is deleting a Step that another had yielded to — rare, and
 * the yielding Step then settles on the hue it would always have had.
 */
export function stepDotColors(
  steps: readonly Pick<WorkflowStepDto, "id" | "createdAt">[],
): Map<string, string> {
  const byCreation = [...steps].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
  const taken = new Set<number>();
  const colors = new Map<string, string>();
  for (const step of byCreation) {
    let hue = stepHue(step.id);
    for (let tries = 0; tries < 12 && taken.has(hue); tries += 1) hue = (hue + 30) % 360;
    taken.add(hue);
    colors.set(step.id, `oklch(0.72 0.17 ${hue})`);
  }
  return colors;
}

/**
 * What React Flow hands `onConnect` and `isValidConnection` — a `Connection`, or an existing
 * `Edge` on a reconnect; only the three fields read here, optional where an Edge leaves them so.
 */
export interface CanvasConnection {
  source: string | null;
  sourceHandle?: string | null | undefined;
  target: string | null;
}

/** A drag from a branch exit, read as the branch edit it is. */
export interface BranchRetarget {
  stepId: string;
  exit: "then" | "else";
  /** A Step id, or null for the end of the pipeline. */
  targetStepId: string | null;
}

/**
 * The one connect gesture the canvas allows, stated as the write it becomes: dragging a
 * branching Step's `Yes` or `No` exit onto another Step, or onto the end, re-points that exit.
 *
 * Null for everything else, and "everything else" is what keeps the graph the model's own: the
 * plain `next` exit is the rank order and cannot be dragged elsewhere without lying about it,
 * the start is not a target, and a Step is not its own (`WORKFLOW_BRANCH_TARGET_IS_SELF` would
 * refuse it anyway — refusing here means the line says so *while* it is being dragged). The
 * server still checks the targets it is given; this is the client's reading, not the rule.
 */
export function branchRetarget(connection: CanvasConnection): BranchRetarget | null {
  const { source, target } = connection;
  const sourceHandle = connection.sourceHandle ?? null;
  if (!source || !target) return null;
  if (sourceHandle !== "then" && sourceHandle !== "else") return null;
  if (source === START_NODE_ID || source === END_NODE_ID) return null;
  if (target === START_NODE_ID || target === source) return null;
  return {
    stepId: source,
    exit: sourceHandle,
    targetStepId: target === END_NODE_ID ? null : target,
  };
}

/**
 * The name a Step is born with, so the `+` needs no form: the operator renames it in place.
 *
 * `Step ${count + 1}` when that is free, and the next free number when it is not: inserting in
 * the middle of a pipeline that already had a "Step 3" used to make a second one, and two Steps
 * with one name turn every edge label and every branch target into a coin flip.
 */
export function nextStepName(steps: readonly WorkflowStepDto[]): string {
  const taken = new Set(steps.map((step) => step.name.trim().toLowerCase()));
  for (let n = steps.length + 1; ; n += 1) {
    const name = `Step ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export interface Point {
  x: number;
  y: number;
}

/**
 * An SVG path through `points` with every corner rounded — the routed edges' shape.
 *
 * Each interior corner is cut short by `radius` on both sides and joined with a quadratic curve
 * whose control point is the corner itself, which is what a rounded corner *is*. The radius is
 * clamped to half of each adjoining segment, so two corners close together share the segment
 * between them instead of overshooting it, and a segment shorter than the radius still draws.
 */
export function roundedPath(points: readonly Point[], radius: number): string {
  const [first, ...rest] = points;
  if (!first) return "";
  if (rest.length === 0) return `M ${first.x} ${first.y}`;
  const parts = [`M ${first.x} ${first.y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1] as Point;
    const corner = points[i] as Point;
    const next = points[i + 1] as Point;
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0) {
      parts.push(`L ${corner.x} ${corner.y}`);
      continue;
    }
    const a = {
      x: corner.x - ((corner.x - prev.x) / inLen) * r,
      y: corner.y - ((corner.y - prev.y) / inLen) * r,
    };
    const b = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    parts.push(`L ${a.x} ${a.y}`, `Q ${corner.x} ${corner.y} ${b.x} ${b.y}`);
  }
  const last = points[points.length - 1] as Point;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}
