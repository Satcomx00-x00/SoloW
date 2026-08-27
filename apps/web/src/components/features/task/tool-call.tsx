"use client";

import { ChevronRight, CircleAlert, CircleCheck, CircleDot, LoaderCircle } from "lucide-react";
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ToolRow } from "./transcript";

/**
 * One tool invocation, rendered as an invocation (issue #2).
 *
 * The terminal printed `tool: Read` and nothing else — a reader could see that *something* ran
 * but not on what, nor whether it worked. Everything a reviewer actually asks of these lines is
 * therefore on the row: which tool, how it ended, what it was given, what came back.
 *
 * Collapsed by default, and that is the point rather than a default someone forgot to change. A
 * run emits hundreds of these; expanded, they are exactly the wall of output this view exists to
 * replace. So the summary line has to stand on its own — the tool's name plus the one argument
 * that says *which* Read this is — and the body is there for the two or three calls a reviewer
 * stops on.
 *
 * A failed call is the exception to all of that restraint: it is tinted, pilled and labelled, so
 * it is findable while scrolling past a hundred quiet successes.
 */

const STATUS: Record<
  NonNullable<ToolRow["status"]>,
  { label: string; icon: typeof CircleDot; className: string; spin?: boolean }
> = {
  // The same tint-plus-icon treatment the Task states use (see `lib/task-states.ts`): colour is
  // never the only signal, so a colour-blind reader gets the glyph and the word too (WCAG 1.4.1).
  pending: {
    label: "Pending",
    icon: CircleDot,
    className: "badge-soft [--badge-color:var(--state-queued)]",
  },
  in_progress: {
    label: "Running",
    icon: LoaderCircle,
    className: "badge-soft [--badge-color:var(--state-running)]",
    spin: true,
  },
  completed: {
    label: "Completed",
    icon: CircleCheck,
    className: "badge-soft [--badge-color:var(--state-done)]",
  },
  failed: {
    label: "Failed",
    icon: CircleAlert,
    className: "badge-soft [--badge-color:var(--state-failed)]",
  },
};

/**
 * The argument that identifies a call, in the order a reader recognises one by. A path answers
 * "which file", a command answers "what did it run", a pattern answers "what was it looking
 * for"; anything else (a `limit`, an `offset`) distinguishes nothing at a glance and is left for
 * whoever opens the row.
 */
const LEAD_KEYS = ["file_path", "command", "pattern"] as const;

function leadArgument(input: ToolRow["input"]): string | null {
  if (!input) return null;
  for (const key of LEAD_KEYS) {
    const value = input[key];
    if (value) return value;
  }
  return null;
}

export function ToolCall({ row }: { row: ToolRow }) {
  const args = row.input ? Object.entries(row.input) : [];
  const status = row.status ? STATUS[row.status] : null;
  const lead = leadArgument(row.input);
  // Either signal alone means failure: the status carries it for a call whose result was folded
  // in, the result carries it for one that arrived orphaned and never had a status of its own.
  const failed = row.status === "failed" || row.result?.ok === false;

  return (
    <details
      data-tool-call={row.name}
      data-tool-status={row.status ?? "unknown"}
      className={cn(
        "group rounded-lg border bg-card/40 px-3 py-2",
        failed && "border-state-failed/40 bg-state-failed/8",
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-open:rotate-90"
        />
        <span className="shrink-0 font-medium font-mono text-xs">{row.name}</span>
        {/* Truncated rather than wrapped: a row that stays one line tall is what keeps a long run
            scannable, and the full value is a hover and an expand away. */}
        {lead && (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
            {lead}
          </span>
        )}
        {status && (
          <Badge
            variant="outline"
            className={cn("ml-auto shrink-0 gap-1 text-2xs", status.className)}
          >
            <status.icon aria-hidden className={cn(status.spin && "spinner")} />
            {status.label}
          </Badge>
        )}
      </summary>

      <div className="mt-2 space-y-2.5 border-t pt-2">
        {args.length === 0 ? (
          /* A real state, not a gap in the render: the orchestrator captures only allowlisted
             keys — an unknown tool contributes none — and ACP never exposes tool input at all.
             Saying so beats an empty box that reads as a bug. */
          <p className="text-2xs text-muted-foreground">No arguments recorded.</p>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {args.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="font-mono text-2xs text-muted-foreground/70">{key}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-2xs">
                  {value}
                </dd>
              </Fragment>
            ))}
          </dl>
        )}

        {row.result === null ? (
          <p className="text-2xs text-muted-foreground/70">No result recorded yet.</p>
        ) : (
          <div>
            <p
              className={cn(
                "font-medium text-2xs",
                row.result.ok ? "text-muted-foreground" : "text-state-failed",
              )}
            >
              {row.result.ok ? "Result" : "Failed"}
            </p>
            {row.result.output ? (
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2.5 font-mono text-2xs leading-[1.7]">
                {row.result.output}
              </pre>
            ) : (
              <p className="mt-1 text-2xs text-muted-foreground">The tool returned no output.</p>
            )}
            {/* Never silent about a cut: a reader who mistakes the head of an output for the whole
                of it will conclude the wrong thing from it, which is worse than not reading it. */}
            {row.result.truncated && (
              <p className="mt-1 text-2xs text-muted-foreground">
                Output truncated — this is the beginning of it, not the whole result.
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
