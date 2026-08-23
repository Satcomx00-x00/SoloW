import { type IssueSource, type IssueStatus, LOCAL_ISSUE_SOURCE } from "@gatecontrol/contracts";
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

/**
 * How an Issue's status looks, mirroring the Task lifecycle treatment in `task-states.ts`.
 *
 * The palette reuses the Task state hues so a reader does not have to learn a second colour
 * language: "something is happening" is the same blue in both, "finished" the same green. There
 * is no amber here on purpose — amber means "a person must act", and an Issue never waits on a
 * human. Its Tasks do.
 */
export interface IssueStatusStyle {
  icon: LucideIcon;
  /** Foreground colour on its own, for a bare glyph or label. */
  text: string;
  /** Tinted pill: fill, text and hairline edge. */
  badge: string;
}

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export const ISSUE_STATUS_STYLE: Record<IssueStatus, IssueStatusStyle> = {
  open: {
    icon: CircleDashed,
    text: "text-state-queued",
    badge: "border-state-queued/30 bg-state-queued/10 text-state-queued",
  },
  in_progress: {
    icon: LoaderCircle,
    text: "text-state-running",
    badge: "border-state-running/35 bg-state-running/12 text-state-running",
  },
  resolved: {
    icon: CircleCheck,
    text: "text-state-done",
    badge: "border-state-done/30 bg-state-done/12 text-state-done",
  },
  closed: {
    icon: CircleSlash,
    text: "text-state-idle",
    badge: "border-state-idle/25 bg-state-idle/10 text-state-idle",
  },
};

/** Rail/filter order: the states you act on first. */
export const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * How a source is spelled where a person reads it.
 *
 * This was a total `Record` over a closed enum, which is exactly what a registry cannot have: the
 * set of providers is no longer known here, and a `Record` missing a key renders `undefined` on
 * screen. So the name comes from the provider's own manifest — `useProviderNames` fetches them —
 * and this falls back to the id itself when there is none.
 *
 * The fallback is the whole of F21 FR-7 in one line. An Issue imported by a build that shipped a
 * Jira driver, opened in one that does not, reads `jira`: not the prettiest label, and a great
 * deal better than `undefined` or a page that will not render. A CSS `capitalize` is deliberately
 * not applied — it would turn `github` into "Github", which is wrong, and the manifest is what
 * knows the right spelling.
 */
export function issueSourceLabel(source: IssueSource, providerName?: string | null): string {
  if (source === LOCAL_ISSUE_SOURCE) return "Local";
  return providerName ?? source;
}
