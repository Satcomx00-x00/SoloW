"use client";

import "@xyflow/react/dist/style.css";
import type { TaskState } from "@solow/contracts";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { Check, CircleDot, Locate, LocateFixed, X } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { type BoardColumn, type BoardItem, needsYou, RUN_COLUMN_ID } from "./task-board-model";

/**
 * The Task as a board: the Workflow's Steps across the top, and under each one what the harness
 * did and asked while it was there, growing as the stream arrives.
 *
 * **One node per Step, the cards inside it.** The Steps are the graph — they are what the
 * Workflow canvas draws and what the edges join. What hangs beneath a Step is a stack, not a
 * graph: it has an order and nothing else, and laying each card out as its own node would mean
 * measuring every card after each render and moving the rest whenever a todo list grew a line.
 * As one column node the stack is ordinary layout, and a card that grows pushes the ones below
 * it down without anything having to be told.
 *
 * **Follow live.** On by default, like the terminal's tail: when a new card lands the view pans
 * to it. Any pan or zoom of your own turns it off — the view is yours from then on — and the
 * button puts it back.
 */

/** Wide enough for a two-line title, narrow enough for four Steps beside an open terminal. */
const COLUMN_WIDTH = 280;
const COLUMN_GAP = 64;
/** The Step header's height: where the backbone edges join. */
const HEADER_MID = 22;
/** What the fit control does: the whole board, never larger than life. */
const FIT_VIEW = { padding: 0.12, maxZoom: 1, minZoom: 0.3 } as const;
/** The opening view's smallest zoom: below this a card's words stop being readable. */
const MIN_OPEN_ZOOM = 0.7;
const OPEN_PADDING = 32;
/** Clear of the Follow live control, which sits over the board's top edge. */
const TOP_INSET = 56;
/** How much room a revealed card keeps from the frame's edge. */
const REVEAL_MARGIN = 24;

interface ColumnData extends Record<string, unknown> {
  column: BoardColumn;
  state: TaskState;
  placeholder: string | null;
  renderItem: (item: BoardItem, column: BoardColumn) => ReactNode;
  onOpenStep: (columnId: string) => void;
  forced: boolean;
  onForceReview?: ((columnId: string, force: boolean) => void) | undefined;
  attention: boolean;
}
type ColumnNode = Node<ColumnData, "column">;

const STATUS_STYLE: Record<BoardColumn["status"], string> = {
  done: "border-state-done/70 text-foreground",
  running: "border-state-running text-foreground shadow-[0_0_0_4px] shadow-state-running/15",
  waiting: "border-state-review text-foreground shadow-[0_0_0_4px] shadow-state-review/15",
  failed: "border-state-failed text-foreground",
  upcoming: "border-border text-muted-foreground",
};

const STATUS_WORD: Record<BoardColumn["status"], string> = {
  done: "done",
  running: "running",
  waiting: "waiting on you",
  failed: "failed",
  upcoming: "not started",
};

/** A Step's header: the backbone's node, and the way into the Step's own dialog. */
function StepHeader({
  column,
  state,
  onOpen,
  forced,
  onForceReview,
}: {
  column: BoardColumn;
  state: TaskState;
  onOpen: () => void;
  /** A review was forced on this Step for this Task. */
  forced: boolean;
  /** Absent for a Task on no Workflow, which has no Step to force a review on. */
  onForceReview?: ((force: boolean) => void) | undefined;
}) {
  const atGate = column.current && state === "review";
  // A Step the Workflow looped back past reads as one that ran, not one that never started.
  const status = column.ranBefore ? "done" : column.status;
  const header = (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cn(
        "flex h-11 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border-2 bg-card px-3 font-semibold text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        STATUS_STYLE[status],
        column.ranBefore && "border-dashed",
      )}
      data-step-status={column.status}
      data-step-passes={column.passes}
    >
      <span className="sr-only">Step. </span>
      {status === "done" ? (
        <Check aria-hidden className="size-3.5 shrink-0 text-state-done" />
      ) : column.status === "running" ? (
        <CircleDot aria-hidden className="size-3.5 shrink-0 text-state-running" />
      ) : column.status === "failed" ? (
        <X aria-hidden className="size-3.5 shrink-0 text-state-failed" />
      ) : null}
      <span className="min-w-0 truncate">{column.name}</span>
      {column.passes > 1 ? (
        <span className="shrink-0 font-normal text-muted-foreground">· pass {column.passes}</span>
      ) : null}
      {column.ranBefore ? (
        <span className="shrink-0 font-normal text-muted-foreground">
          · ran {column.passes === 1 ? "once" : `${column.passes}×`}
        </span>
      ) : null}
      {atGate ? <span className="shrink-0 font-normal text-state-review">· at gate</span> : null}
      {forced && !atGate ? (
        <span className="shrink-0 font-normal text-state-review">· review forced</span>
      ) : null}
      <span className="sr-only">
        ,{" "}
        {column.ranBefore
          ? "ran before, runs again when the workflow returns to it"
          : STATUS_WORD[column.status]}
      </span>
    </button>
  );
  if (!onForceReview) return header;
  /*
   * Right-click: the Step's own controls. "Force review" makes this Step wait for a person at its
   * next finish whatever its gate says — for the Step that moved on by itself when you wanted to
   * look first. Per Task; the Workflow is untouched.
   */
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent className="w-72">
        <ContextMenuLabel className="truncate text-2xs text-muted-foreground">
          Step · {column.name}
        </ContextMenuLabel>
        <ContextMenuCheckboxItem
          checked={forced}
          onCheckedChange={(on) => onForceReview(on === true)}
        >
          Force review on this step
        </ContextMenuCheckboxItem>
        <p className="px-2 pb-1.5 text-2xs text-muted-foreground leading-snug">
          {column.current
            ? "When this step finishes, the task waits for your approval before moving on."
            : "When the workflow reaches this step, it waits for your approval before moving on."}
        </p>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpen}>Open step details</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ColumnNodeView({ data }: NodeProps<ColumnNode>) {
  const { column, state, placeholder, renderItem, onOpenStep, forced, onForceReview } = data;
  return (
    <section
      aria-label={`Step ${column.name}`}
      className="flex flex-col"
      style={{ width: COLUMN_WIDTH }}
      data-board-column={column.id}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!opacity-0"
        style={{ top: HEADER_MID }}
      />
      <StepHeader
        column={column}
        state={state}
        onOpen={() => onOpenStep(column.id)}
        forced={forced}
        onForceReview={onForceReview ? (force) => onForceReview(column.id, force) : undefined}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!opacity-0"
        style={{ top: HEADER_MID }}
      />
      {column.items.length > 0 ? (
        <ol className="flex flex-col">
          {column.items.map((item) => (
            <li key={item.key} className="flex flex-col items-center" data-board-item={item.key}>
              {/* The stack's spine: what joins a card to the Step above it. */}
              <span
                aria-hidden
                className={cn(
                  "h-4 w-px",
                  needsYou(item, state)
                    ? "border-state-review border-l-2 border-dashed"
                    : "bg-border",
                )}
              />
              {renderItem(item, column)}
            </li>
          ))}
        </ol>
      ) : placeholder ? (
        <div className="flex flex-col items-center">
          <span aria-hidden className="h-4 w-px bg-border" />
          <p className="w-full rounded-xl border-2 border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
            {placeholder}
          </p>
        </div>
      ) : null}
    </section>
  );
}

const NODE_TYPES = { column: ColumnNodeView };
const NO_FORCED: readonly string[] = [];

/** Roughly how tall a column will draw: the header, and a card's worth per item. */
function estimatedHeight(column: BoardColumn): number {
  return 44 + Math.max(1, column.items.length) * 110;
}

function Board({
  columns,
  state,
  live,
  renderItem,
  onOpenStep,
  forcedReview = NO_FORCED,
  onForceReview,
  latestKey,
  label,
  handle,
}: TaskBoardProps) {
  const flow = useReactFlow();
  const container = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  /** Set while the board itself is moving the view, so the move is not read as yours. */
  const moving = useRef(false);

  const nodes = useMemo<ColumnNode[]>(
    () =>
      columns.map((column, index) => {
        const before = columns[index - 1];
        const placeholder =
          column.status !== "upcoming"
            ? null
            : column.ranBefore
              ? "ran before — runs again when the workflow returns here"
              : before?.current && state === "review"
                ? "after approval"
                : "not started";
        return {
          id: column.id,
          type: "column",
          position: { x: index * (COLUMN_WIDTH + COLUMN_GAP), y: 0 },
          // A size before the DOM has one: React Flow keeps an unmeasured node hidden, and the
          // first fit would otherwise be made around nothing. The browser corrects it a frame later.
          initialWidth: COLUMN_WIDTH,
          initialHeight: estimatedHeight(column),
          draggable: false,
          selectable: false,
          // React Flow gives a node that is neither draggable, selectable nor connectable
          // `pointer-events: none`, so a press on a card falls through to the canvas. Every card
          // and Step header in the column is a button, so the column takes the pointer back.
          style: { pointerEvents: "all" },
          data: {
            column,
            state,
            placeholder,
            renderItem,
            onOpenStep,
            forced: forcedReview.includes(column.id),
            ...(onForceReview && column.id !== RUN_COLUMN_ID ? { onForceReview } : {}),
            attention: column.items.some((item) => needsYou(item, state)),
          },
        };
      }),
    [columns, state, renderItem, onOpenStep, forcedReview, onForceReview],
  );

  const edges = useMemo<Edge[]>(
    () =>
      columns.slice(1).map((column, index) => {
        const from = columns[index];
        const reached = from?.status === "done";
        const flowing = reached && column.status === "running" && live;
        return {
          id: `${from?.id}->${column.id}`,
          source: from?.id ?? "",
          target: column.id,
          type: "straight",
          focusable: false,
          ...(flowing ? { className: "task-board-edge-live" } : {}),
          style: {
            stroke: reached ? "var(--state-done)" : "var(--border)",
            strokeWidth: 2,
          },
        };
      }),
    [columns, live],
  );

  /** Move the view by the board, never read as the operator's own move. */
  const moveTo = useCallback(
    (viewport: { x: number; y: number; zoom: number }, duration: number) => {
      moving.current = true;
      void flow.setViewport(viewport, { duration }).finally(() => {
        moving.current = false;
      });
    },
    [flow],
  );

  /**
   * Bring a card into view the way a list scrolls to a row: not at all when it is already on
   * screen, and otherwise only as far as it takes — at the zoom the operator is using. Read off
   * the DOM because the card's place inside its column is layout, which only the browser knows.
   */
  const reveal = useCallback(
    (key: string) => {
      const frame = container.current;
      const el = frame?.querySelector<HTMLElement>(`[data-board-item="${CSS.escape(key)}"]`);
      if (!frame || !el) return;
      const box = el.getBoundingClientRect();
      const view = frame.getBoundingClientRect();
      const along = (start: number, size: number, from: number, room: number) => {
        // Taller (or wider) than the room: its start is what reads first.
        if (size > room - 2 * REVEAL_MARGIN || start < from + REVEAL_MARGIN)
          return start - (from + REVEAL_MARGIN);
        if (start + size > from + room - REVEAL_MARGIN)
          return start + size - (from + room - REVEAL_MARGIN);
        return 0;
      };
      const dx = along(box.left, box.width, view.left, view.width);
      const dy = along(box.top, box.height, view.top + TOP_INSET, view.height - TOP_INSET);
      if (dx === 0 && dy === 0) return;
      const at = flow.getViewport();
      moveTo({ x: at.x - dx, y: at.y - dy, zoom: at.zoom }, 300);
    },
    [flow, moveTo],
  );

  useImperativeHandle(handle, () => ({ reveal }), [reveal]);

  /**
   * Where the board opens: the Step headers along the top, at full size when that fits the
   * width (scaled down to `MIN_OPEN_ZOOM` when it does not), centred when the row is narrower
   * than the frame and otherwise scrolled so the Step the run is on is on screen. Redone while
   * the shape is still arriving — the binding answers a query after the Task does, and a board
   * laid out for one column would sit off-centre once it had three — and never after the
   * operator has moved the view themselves.
   */
  const touched = useRef(false);
  const currentIndex = columns.findIndex((column) => column.current);
  useEffect(() => {
    const frame = container.current;
    if (touched.current || !frame || columns.length === 0) return;
    const width = frame.clientWidth;
    const row = columns.length * COLUMN_WIDTH + (columns.length - 1) * COLUMN_GAP;
    const zoom = Math.min(1, Math.max(MIN_OPEN_ZOOM, (width - 2 * OPEN_PADDING) / row));
    const shown = row * zoom;
    let x = shown + 2 * OPEN_PADDING <= width ? (width - shown) / 2 : OPEN_PADDING;
    const right = (Math.max(0, currentIndex) * (COLUMN_WIDTH + COLUMN_GAP) + COLUMN_WIDTH) * zoom;
    if (x + right > width - OPEN_PADDING) x = width - OPEN_PADDING - right;
    moveTo({ x, y: TOP_INSET, zoom }, 0);
  }, [columns.length, currentIndex, moveTo]);

  /**
   * Follow live: the newest card, whenever it changes — including the first, so a board that
   * opens on a question shows the question. Two frames late: one for the opening viewport to
   * land, one for the card to have been laid out under it. Re-run with the opening view, which
   * the binding's late answer redoes and would otherwise undo the reveal.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shape is the trigger, not an input
  useEffect(() => {
    if (!following || latestKey === null) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => reveal(latestKey));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [following, latestKey, reveal, columns.length, currentIndex]);

  return (
    <div ref={container} className="task-board relative h-full w-full overflow-hidden">
      <ReactFlow<ColumnNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        aria-label={label}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        minZoom={0.3}
        maxZoom={1.5}
        // A move that the board did not make is the operator taking the view: following stops.
        onMoveStart={(event) => {
          if (event && !moving.current) {
            touched.current = true;
            setFollowing(false);
          }
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
        <Panel position="top-right">
          <button
            type="button"
            aria-pressed={following}
            onClick={() => setFollowing((was) => !was)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs transition-colors hover:bg-accent",
              following ? "border-state-running text-state-running" : "text-muted-foreground",
            )}
          >
            {following ? (
              <LocateFixed aria-hidden className="size-3.5" />
            ) : (
              <Locate aria-hidden className="size-3.5" />
            )}
            Follow live
          </button>
        </Panel>
        {/* Open asks marked in amber, so one off-screen is still found from the corner. */}
        <MiniMap<ColumnNode>
          pannable
          zoomable
          ariaLabel="Board overview"
          nodeColor={(node) =>
            node.data.attention
              ? "var(--state-review)"
              : node.data.column.current
                ? "var(--state-running)"
                : "var(--muted-foreground)"
          }
          nodeStrokeWidth={0}
        />
      </ReactFlow>
    </div>
  );
}

export interface TaskBoardProps {
  columns: readonly BoardColumn[];
  state: TaskState;
  /** A harness is running and the stream is open: the edge into the running Step flows. */
  live: boolean;
  renderItem: (item: BoardItem, column: BoardColumn) => ReactNode;
  /** A Step header pressed: open that Step's dialog. */
  onOpenStep: (columnId: string) => void;
  /** Steps a review was forced on for this Task, and the right-click that changes it. */
  forcedReview?: readonly string[];
  onForceReview?: ((stepId: string, force: boolean) => void) | undefined;
  /** The newest card's key — what Follow live pans to — or null when there is none. */
  latestKey: string | null;
  /** The canvas's accessible name. */
  label: string;
  /** For the page's own "take me to it" gestures: the legend, and Approve with decisions open. */
  handle?: RefObject<BoardHandle | null> | undefined;
}

export interface BoardHandle {
  /** Pan to a card by its item key, at the current zoom. */
  reveal: (key: string) => void;
}

export function TaskBoard(props: TaskBoardProps) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}
