import type { AgentHandle, PermissionAnswer } from "./runner.js";

/**
 * Live agent registry (tasks TASK-014 / TASK-022). The durable lifecycle owns the agent handle,
 * but the WebSocket hub is the one holding the operator's connection, so it needs a way to
 * reach the agent that belongs to a given Task.
 *
 * The key includes the Workspace, and the hub only ever looks up the Workspace named in the
 * subscriber's signed ticket — so a client cannot steer another tenant's agent (Principle V).
 *
 * In-memory and process-local by design: a handle is a live process, and a run whose
 * orchestrator restarted has no agent to steer until the workflow resumes and registers again.
 */

/**
 * What became of a permission answer that had to find an agent first — the handle's own three
 * outcomes, plus the two only the registry can see.
 */
export type PermissionAnswerResult = PermissionAnswer | "no_agent" | "no_permission_channel";

export interface LiveAgent {
  taskId: string;
  sessionId: string;
  handle: AgentHandle;
}

export class AgentRegistry {
  private readonly agents = new Map<string, LiveAgent>();

  private static key(workspaceId: string, taskId: string): string {
    return `${workspaceId}:${taskId}`;
  }

  /** Register a running agent; returns the deregistration function. */
  register(workspaceId: string, agent: LiveAgent): () => void {
    const key = AgentRegistry.key(workspaceId, agent.taskId);
    this.agents.set(key, agent);
    return () => {
      // Only clear our own entry: a retry may already have registered a newer run.
      if (this.agents.get(key) === agent) this.agents.delete(key);
    };
  }

  get(workspaceId: string, taskId: string): LiveAgent | undefined {
    return this.agents.get(AgentRegistry.key(workspaceId, taskId));
  }

  /** Deliver operator input. `false` means there was no live agent able to take it. */
  async send(workspaceId: string, taskId: string, text: string): Promise<boolean> {
    const agent = this.get(workspaceId, taskId);
    if (!agent) return false;
    return agent.handle.send(text);
  }

  /**
   * Answer a permission the agent asked for (issue #58, AC-4). Keyed by Workspace exactly like
   * `send` and `stop`, so a client can only ever answer for the one agent its signed ticket
   * granted (Principle V).
   *
   * The four outcomes are kept apart all the way to the operator's terminal: nothing running,
   * a protocol with no permission channel, a question already settled, and an option the agent
   * never offered are four different things to be told, and telling an operator mid-run that
   * "no agent is running" because their dialog was two seconds late is not one of them.
   */
  async respondPermission(
    workspaceId: string,
    taskId: string,
    requestId: string,
    optionId: string,
  ): Promise<PermissionAnswerResult> {
    const agent = this.get(workspaceId, taskId);
    if (!agent) return "no_agent";
    if (!agent.handle.respondPermission) return "no_permission_channel";
    return agent.handle.respondPermission(requestId, optionId);
  }

  /** Stop the agent. `false` means there was nothing running to stop. */
  async stop(workspaceId: string, taskId: string): Promise<boolean> {
    const agent = this.get(workspaceId, taskId);
    if (!agent) return false;
    await agent.handle.stop();
    return true;
  }

  get size(): number {
    return this.agents.size;
  }
}

/** Process-wide registry shared by the lifecycle and the hub. */
export const agentRegistry = new AgentRegistry();
