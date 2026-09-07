import type { WidgetResponse } from "@solow/contracts";
import type { HarnessHandle, PermissionAnswer } from "./runner.js";

/**
 * Live harness registry (tasks TASK-014 / TASK-022). The durable lifecycle owns the harness handle,
 * but the WebSocket hub is the one holding the operator's connection, so it needs a way to
 * reach the harness that belongs to a given Task.
 *
 * The key includes the Workspace, and the hub only ever looks up the Workspace named in the
 * subscriber's signed ticket — so a client cannot steer another tenant's harness (Principle V).
 *
 * In-memory and process-local by design: a handle is a live process, and a run whose
 * orchestrator restarted has no harness to steer until the workflow resumes and registers again.
 */

/**
 * What became of a permission answer that had to find a harness first — the handle's own three
 * outcomes, plus the two only the registry can see.
 */
export type PermissionAnswerResult = PermissionAnswer | "no_agent" | "no_permission_channel";

/**
 * What became of a widget answer. `not_pending` and `option_unknown` are the run's judgement —
 * only the lifecycle knows which widgets are outstanding and what each offered — and `no_agent`
 * is the registry's.
 */
export type WidgetAnswer = "answered" | "not_pending" | "option_unknown";
export type WidgetAnswerResult = WidgetAnswer | "no_agent" | "no_widget_channel";

export interface LiveHarness {
  taskId: string;
  sessionId: string;
  handle: HarnessHandle;
  /**
   * How to answer an interactive widget this run emitted.
   *
   * Supplied by the lifecycle rather than implemented here, because answering one means three
   * things the registry has no business knowing: validating the answer against the widget that
   * asked, appending a `widget_response` to the session log, and telling the harness in words it
   * will understand. The registry's job is finding the right harness under the right tenant key.
   */
  respondWidget?: (response: WidgetResponse) => Promise<WidgetAnswer>;
}

export class HarnessRegistry {
  private readonly harnesses = new Map<string, LiveHarness>();

  private static key(workspaceId: string, taskId: string): string {
    return `${workspaceId}:${taskId}`;
  }

  /** Register a running harness; returns the deregistration function. */
  register(workspaceId: string, harness: LiveHarness): () => void {
    const key = HarnessRegistry.key(workspaceId, harness.taskId);
    this.harnesses.set(key, harness);
    return () => {
      // Only clear our own entry: a retry may already have registered a newer run.
      if (this.harnesses.get(key) === harness) this.harnesses.delete(key);
    };
  }

  get(workspaceId: string, taskId: string): LiveHarness | undefined {
    return this.harnesses.get(HarnessRegistry.key(workspaceId, taskId));
  }

  /** Deliver operator input. `false` means there was no live harness able to take it. */
  async send(workspaceId: string, taskId: string, text: string): Promise<boolean> {
    const harness = this.get(workspaceId, taskId);
    if (!harness) return false;
    return harness.handle.send(text);
  }

  /**
   * Answer an interactive widget. Keyed by Workspace exactly like `send`, `stop` and
   * `respondPermission`, so a client can only ever answer for the one harness its ticket granted
   * (Principle V).
   */
  async respondWidget(
    workspaceId: string,
    taskId: string,
    response: WidgetResponse,
  ): Promise<WidgetAnswerResult> {
    const harness = this.get(workspaceId, taskId);
    if (!harness) return "no_agent";
    if (!harness.respondWidget) return "no_widget_channel";
    return harness.respondWidget(response);
  }

  /**
   * Answer a permission the harness asked for (issue #58, AC-4). Keyed by Workspace exactly like
   * `send` and `stop`, so a client can only ever answer for the one harness its signed ticket
   * granted (Principle V).
   *
   * The four outcomes are kept apart all the way to the operator's terminal: nothing running,
   * a protocol with no permission channel, a question already settled, and an option the harness
   * never offered are four different things to be told, and telling an operator mid-run that
   * "no harness is running" because their dialog was two seconds late is not one of them.
   */
  async respondPermission(
    workspaceId: string,
    taskId: string,
    requestId: string,
    optionId: string,
  ): Promise<PermissionAnswerResult> {
    const harness = this.get(workspaceId, taskId);
    if (!harness) return "no_agent";
    if (!harness.handle.respondPermission) return "no_permission_channel";
    return harness.handle.respondPermission(requestId, optionId);
  }

  /** Stop the harness. `false` means there was nothing running to stop. */
  async stop(workspaceId: string, taskId: string): Promise<boolean> {
    const harness = this.get(workspaceId, taskId);
    if (!harness) return false;
    await harness.handle.stop();
    return true;
  }

  get size(): number {
    return this.harnesses.size;
  }
}

/** Process-wide registry shared by the lifecycle and the hub. */
export const harnessRegistry = new HarnessRegistry();
