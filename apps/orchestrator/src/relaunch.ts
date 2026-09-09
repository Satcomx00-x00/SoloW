import { inngest } from "./inngest/client.js";

/**
 * Putting a lost run back on the engine — the half of automatic recovery that talks to Inngest.
 *
 * Split out of `reconcile.ts` rather than written inside it for one reason, and it is an import
 * graph rather than a preference: `executor/reap.ts` imports `reconcile.ts` for two constants, so
 * anything the reconciler pulls in the reaper pulls in too. The reconciler stays a module of
 * queries and verdicts that a test can drive with nothing but a database; the Inngest SDK lives
 * here, behind an interface the reconciler only names.
 *
 * The event names are string literals in both this module and `task-run.ts`'s trigger, which is
 * the one place a typo would be silent — `inngest.send` accepts any name, and an event nothing is
 * subscribed to is dropped without complaint. There is no shared enum to reach for: the third
 * producer, `apps/web/src/server/orchestrator-client.ts`, spells them the same way for the same
 * reason (`packages/contracts/src/workspace.ts` says so where it names the two older events).
 */

/** A run to put back, in exactly the terms the launch event carries. */
export interface RelaunchTarget {
  workspaceId: string;
  taskId: string;
  /**
   * The Session the lost run was writing into — **the existing row, never a new one**.
   *
   * Session rows are created in one place, the web app's `createSession` (`server/dal/session.ts`,
   * from `routers/task.ts`), and automatic recovery must not become a second. Reuse is also what
   * makes the recovery a recovery rather than a restart: `session.harness_session_id` on that row
   * is the harness's own conversation id, written mid-run precisely so a dying run still records
   * it, and the transcript a reviewer reads afterwards stays one continuous log instead of
   * splitting into a pair of half-runs with nothing saying they are the same piece of work.
   */
  sessionId: string;
}

/**
 * The engine, as much of it as recovering a run needs.
 *
 * An interface rather than the client itself so `reconcile.ts` can be driven without one — a
 * sweep given no relauncher reaches its terminal ladder exactly as it did before this existed,
 * which is what most of `reconcile.test.ts` is about.
 */
export interface RunRelauncher {
  relaunch(target: RelaunchTarget): Promise<void>;
}

/** What `POST /events` and `orchestrator-client.ts` both put on the wire. */
export type EventSend = (payload: {
  name: string;
  data: Record<string, unknown>;
}) => Promise<unknown>;

/**
 * Relaunch through the orchestrator's own Inngest client.
 *
 * **Two events, in this order, and the first one is not optional.** The reconciler decides a run
 * is gone from two signals that cannot rule out every false positive — see `reclaimOrphanedRuns` —
 * so "gone" is occasionally a run that is merely silent, and launching a second one on top of it
 * would put two harnesses in one worktree with no precedence between them. That is the failure
 * this codebase refuses everywhere else, and it is strictly worse than the stale verdict the
 * sweep used to write. `task.stop.requested` is the cancellation channel `taskRun` already
 * subscribes to (`cancelOn`, matched on `taskId`), so sending it first makes the verdict true
 * instead of racing it: whatever was still in there is unwound, and only then is anything started.
 *
 * The order also protects the new run. Inngest matches a `cancelOn` event against runs that are
 * already in flight, so a stop sent strictly before the launch cannot reach the run that launch
 * creates — which is why these are two awaited sends and not one `Promise.all`.
 *
 * Cancelling costs the abandoned run nothing that matters: Inngest stops between steps, so the
 * lifecycle's `finally` never runs and no worktree is disposed. The new run adopts the same
 * container through `ensureContainer` and resumes in the same worktree, which is the whole point.
 *
 * A rejection from either send is left to the caller, and the caller treats it as "no recovery
 * happened" — an engine that did not accept the stop must never be sent the launch.
 */
export function createRelauncher(send: EventSend): RunRelauncher {
  return {
    async relaunch(target) {
      await send({ name: "task.stop.requested", data: { ...target } });
      await send({ name: "task.launch.requested", data: { ...target } });
    },
  };
}

/** The production wiring: the same singleton client `POST /events` forwards into. */
export function defaultRelauncher(): RunRelauncher {
  return createRelauncher((payload) => inngest.send(payload));
}
