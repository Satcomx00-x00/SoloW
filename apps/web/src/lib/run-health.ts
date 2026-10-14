import type { AttentionItemDto, SystemHealthDto } from "@solow/contracts";
import { QUIET_RUN_MS } from "@solow/core";
import { failureReasonLabel } from "@/lib/task-states";

/**
 * The words for the product's own health (FINDINGS F3): what the status bar and the notices say
 * when a service is down or a run needs a person. Kept apart from the components so the sentences
 * can be read and tested in one place — they are the feature, more than the markup around them.
 */

export type HealthTone = "ok" | "caution" | "error";

export interface ServiceLine {
  name: string;
  ok: boolean;
  /** What this means for the user, and what to do about it. */
  text: string;
}

export interface HealthSummary {
  tone: HealthTone;
  /** The status bar's few words. */
  label: string;
  services: ServiceLine[];
}

const RESTART = "Restart SoloW with the launcher you started it with.";

export function healthSummary(health: SystemHealthDto): HealthSummary {
  const { orchestrator, engine } = health;
  const services: ServiceLine[] = [];

  if (orchestrator.state === "ok") {
    services.push({ name: "Orchestrator", ok: true, text: "Answering." });
  } else if (orchestrator.state === "not_configured") {
    services.push({
      name: "Orchestrator",
      ok: false,
      text: `This web app was started without one, so runs cannot start. ${RESTART}`,
    });
  } else if (orchestrator.state === "outdated") {
    services.push({
      name: "Orchestrator",
      ok: false,
      text: `Running, but an older version than this web app, so it cannot report on itself or the run engine. ${RESTART}`,
    });
  } else {
    services.push({
      name: "Orchestrator",
      ok: false,
      text: `Not answering. Runs cannot start, live output has stopped, and lost runs are not recovered. Work already done is kept. ${RESTART}`,
    });
  }

  if (engine.state === "ok") {
    services.push({ name: "Run engine", ok: true, text: "Answering." });
  } else if (engine.state === "unreachable") {
    services.push({
      name: "Run engine",
      ok: false,
      text: `Not answering. New runs will not start and running ones cannot move to their next step. Work already done is kept. ${RESTART}`,
    });
  } else {
    services.push({
      name: "Run engine",
      ok: true,
      text:
        orchestrator.state === "ok"
          ? "Not checked: the orchestrator did not report on it."
          : "Not checked: only the orchestrator can reach it.",
    });
  }

  // The machine's own words go last, for whoever is debugging; the sentence is for the user.
  const [orchestratorLine, engineLine] = services as [ServiceLine, ServiceLine];
  if (!orchestratorLine.ok && orchestrator.detail) {
    orchestratorLine.text += ` (${orchestrator.detail})`;
  }
  if (!engineLine.ok && engine.detail) engineLine.text += ` (${engine.detail})`;

  if (orchestrator.state === "not_configured") {
    return { tone: "caution", label: "no orchestrator", services };
  }
  if (orchestrator.state === "outdated") {
    return { tone: "caution", label: "orchestrator outdated", services };
  }
  if (orchestrator.state !== "ok") return { tone: "error", label: "orchestrator down", services };
  if (engine.state === "unreachable") return { tone: "error", label: "engine down", services };
  return { tone: "ok", label: "healthy", services };
}

/** How one Task on the "needs attention" list reads: a short label and the sentence behind it. */
export function attentionCopy(item: AttentionItemDto): { label: string; detail: string } {
  switch (item.cause) {
    case "failed": {
      const reason = item.failureReason ? failureReasonLabel(item.failureReason) : null;
      return {
        label: reason?.label ?? "Run failed",
        detail:
          reason?.detail ?? "The run stopped with an error. Open the Task to read why, then retry.",
      };
    }
    case "decision_not_applied":
      return {
        label: "Decision not applied",
        detail:
          "A review decision was recorded and the run that applies it never started. Decide again; nothing was lost.",
      };
    case "park_never_resumed":
    case "park_overdue":
      return {
        label: "Never resumed",
        detail:
          "It was paused to wait out a usage limit and did not wake up when the limit reset. Retry starts the round again; the work so far is kept.",
      };
    case "run_silent":
      return {
        label: "No activity",
        detail: `Running, but nothing has happened for over ${Math.round(QUIET_RUN_MS / 60_000)} minutes. It may be stuck: open it to check, and stop it if it is.`,
      };
  }
}

/** The notice for a Task that has just joined the list. */
export function attentionNotice(item: AttentionItemDto): {
  title: string;
  description: string;
  tone: "error" | "caution";
} {
  const { label, detail } = attentionCopy(item);
  return {
    title: item.kind === "failed" ? `Run failed: ${item.title}` : `${label}: ${item.title}`,
    description: item.kind === "failed" && label !== "Run failed" ? `${label}. ${detail}` : detail,
    tone: item.kind === "failed" ? "error" : "caution",
  };
}
