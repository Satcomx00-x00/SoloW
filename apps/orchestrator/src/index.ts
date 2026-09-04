/// <reference types="bun-types" />
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentProbeRequest, announceRequest, taskInputSchema } from "@solow/contracts";
import { type StreamTicketClaims, streamChannel, verifyStreamTicket } from "@solow/core/stream";
import { createDb, type Db } from "@solow/db";
import { probeAgent } from "./agent/probe.js";
import {
  type AgentRegistry,
  agentRegistry,
  type PermissionAnswerResult,
  type WidgetAnswerResult,
} from "./agent/registry.js";
import { prepareAgentEnv } from "./billing/guard.js";
import { loadAgentProbeContext, updateAgentCatalogCapabilities } from "./data.js";
import { orchestratorEnv } from "./env.js";
import { createLocalExecutor } from "./executor/local.js";
import { reapOrphanedContainers } from "./executor/reap.js";
import type { Executor } from "./executor/types.js";
import { inngest } from "./inngest/client.js";
import { handleEventPost } from "./inngest/events.js";
import { INNGEST_FUNCTIONS, inngestServeHandler } from "./inngest/serve.js";
import { reclaimOrphanedRuns, reportStrandedParks, reportStrandedReviews } from "./reconcile.js";
import { hub } from "./ws/hub.js";
import { attachSubscriber } from "./ws/replay.js";

export { inngest };
// Re-exported from `serve.ts` rather than built here a second time — see that file's own comment
// on the bug this used to be able to reproduce (this list drifting from the one Inngest is
// actually served).
export const functions = INNGEST_FUNCTIONS;

interface WsData {
  claims: StreamTicketClaims;
  channel: string;
  /** Last `seq` the client already has; replay resumes just after it. */
  since: number;
  unsubscribe?: () => void;
}

/** Collaborators the WS server needs, injectable so the auth/replay paths are testable. */
export interface WsServerDeps {
  db: Db;
  now: () => number;
  streamSecret: string;
  /** Where a client's input or stop is routed — the agent running that Task, if any. */
  registry: AgentRegistry;
  /**
   * How the container reaper reaches the Docker daemon (issue #96).
   *
   * A host `Executor`, not a Docker client: the reaper composes `docker ps` / `docker rm` argv
   * the same way the driver does, which is what keeps "exactly one file touches the host" true
   * with a container driver in the tree. Injectable so the fake-deps tests can drive the sweep
   * without a daemon.
   */
  dockerHost: Executor;
}

function defaultWsDeps(): WsServerDeps {
  return {
    db: createDb(),
    now: () => Date.now(),
    streamSecret: orchestratorEnv().SOLOW_STREAM_SECRET,
    registry: agentRegistry,
    // `process.cwd()` as its root because the reaper uses only `exec`, and every command it
    // issues names what it acts on. In idiom with `handleProbePost` below.
    dockerHost: createLocalExecutor(process.cwd()),
  };
}

/**
 * Authorize an upgrade request (TASK-018). The connection carries a short-lived ticket the web
 * API signed after checking the session and Workspace ownership. The channel is derived from
 * the ticket's own claims — a client cannot name one — so a subscriber can only ever read its
 * own Workspace's stream (Principle V).
 */
export function authorizeUpgrade(
  url: string,
  deps: Pick<WsServerDeps, "now" | "streamSecret">,
): { ok: true; data: Omit<WsData, "unsubscribe"> } | { ok: false; status: number; error: string } {
  const params = new URL(url).searchParams;
  const ticket = params.get("ticket");
  if (!ticket) return { ok: false, status: 401, error: "ticket_required" };

  const verified = verifyStreamTicket(ticket, deps.streamSecret, deps.now());
  if (!verified.ok) return { ok: false, status: 401, error: verified.error };

  const sinceRaw = Number(params.get("since") ?? "-1");
  const since = Number.isFinite(sinceRaw) ? Math.trunc(sinceRaw) : -1;
  return {
    ok: true,
    data: { claims: verified.claims, channel: streamChannel(verified.claims), since },
  };
}

/**
 * Tell every client watching that a Task changed, when the change was made by the API rather
 * than by a run.
 *
 * The hub lives in this process and the web app does not, so a state change made by a person —
 * moving a card, opening the review gate, retrying — reached only the browser that made it. Its
 * own client refetched and every other one sat on a stale board until someone reloaded, which is
 * exactly the "I have to refresh" this endpoint removes.
 *
 * Authorised by the same signed ticket the WebSocket upgrade takes, and the Workspace and Task
 * are read from the ticket's *claims* — never from the body, so a caller cannot announce into
 * another tenant's channel (Principle V). It publishes and nothing else: no state is written
 * here, because the API already wrote it. This is the notification, not the change.
 */
export async function handleAnnouncePost(
  req: Request,
  deps: Pick<WsServerDeps, "now" | "streamSecret">,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid_json", { status: 400 });
  }
  const parsed = announceRequest.safeParse(body);
  if (!parsed.success) return new Response("invalid_request", { status: 400 });

  const verified = verifyStreamTicket(parsed.data.ticket, deps.streamSecret, deps.now());
  if (!verified.ok) return new Response(verified.error, { status: 401 });
  const { workspaceId, taskId } = verified.claims;
  // A board-scoped ticket names no Task, and there is no Task-shaped news to publish without
  // one. Refused rather than broadcast, so the frame's `taskId` is always a real Task.
  if (!taskId) return new Response("task_ticket_required", { status: 400 });

  const message = {
    kind: "status" as const,
    taskId,
    state: parsed.data.state,
    at: new Date(deps.now()).toISOString(),
  };
  hub.publish(hub.boardChannel(workspaceId), message);
  hub.publish(hub.taskChannel(workspaceId, taskId), message);
  return new Response(null, { status: 202 });
}

/**
 * `POST /probe-agent` — start the agent an Agent Profile names, ask it what it is, and stop it.
 *
 * Why this lives here rather than in the web API: the API is forbidden to reach the execution
 * host at all (`scripts/audit-executor-boundary.ts`), and a probe is by definition a spawn. Why
 * it is authenticated by a signed ticket rather than left open like `/events`: it starts a binary
 * an Owner chose, with that Owner's credential in its environment, so an unauthenticated route
 * here would be a remote command execution with a stolen wallet attached.
 *
 * The Workspace comes from the ticket's claims, never the body. A *board-scoped* ticket (no
 * `taskId`) is exactly right and is what the API mints: a probe belongs to Settings, before any
 * Task exists to scope it to.
 */
export async function handleProbePost(
  req: Request,
  deps: Pick<WsServerDeps, "db" | "now" | "streamSecret">,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid_json", { status: 400 });
  }
  const parsed = agentProbeRequest.safeParse(body);
  if (!parsed.success) return new Response("invalid_request", { status: 400 });

  const verified = verifyStreamTicket(parsed.data.ticket, deps.streamSecret, deps.now());
  if (!verified.ok) return new Response(verified.error, { status: 401 });
  const { workspaceId } = verified.claims;

  const ctx = await loadAgentProbeContext(deps.db, workspaceId, parsed.data.agentProfileId);
  if (!ctx) return new Response("agent_profile_not_found", { status: 404 });

  /*
   * The same environment a real run would get, from the same billing guard — because "works with
   * my credential" is most of what the question means, and a probe that shaped its own env would
   * be testing a configuration no run will ever use.
   */
  const shaped = prepareAgentEnv({
    authMode: ctx.agentProfile.authMode,
    secretCiphertext: ctx.secretCiphertext,
    baseEnv: process.env,
    subscriptionEnvVar: ctx.agentCatalog.subscriptionEnvVar,
    meteredEnvVar: ctx.agentCatalog.meteredEnvVar,
  });
  if (!shaped.ok) {
    return Response.json({
      ok: false,
      reason: "this Profile has no usable credential — check the Secret it points at",
      protocolVersion: null,
      authMethods: [],
      capabilities: { models: [], modes: [] },
    });
  }

  /*
   * A scratch directory, not a worktree. An ACP agent is handed a `cwd` it may read, and giving
   * it a real Repository to answer "are you installed" would put a probe's blast radius above
   * its purpose. Removed either way — a probe must not leave anything behind.
   */
  const cwd = await mkdtemp(join(tmpdir(), "solow-probe-"));
  try {
    const report = await probeAgent(createLocalExecutor(cwd), {
      command: ctx.agentCatalog.command,
      args: ctx.agentCatalog.argsTemplate ?? [],
      env: shaped.data,
      cwd,
      protocol: ctx.agentCatalog.protocol,
    });

    /*
     * Fill the cache the Profile form reads (issue #94 AC-2). Until now only a completed run
     * ever wrote it, so every picker was empty until after the first Task — the ordering this
     * whole feature exists to invert. Written on the same fire-and-forget footing the run uses:
     * the probe's answer must not fail because its bookkeeping did.
     */
    if (
      report.ok &&
      (report.capabilities.models.length > 0 || report.capabilities.modes.length > 0)
    ) {
      await updateAgentCatalogCapabilities(
        deps.db,
        workspaceId,
        ctx.agentCatalog.id,
        report.capabilities,
      ).catch(() => {});
    }
    return Response.json(report);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Reconnect replay and the stored-event → wire-frame projection now live in `ws/replay.ts`, so
 * the live publish path in `task-run.ts` and this one share a single projection instead of two
 * hand-kept-in-sync copies (issue #2, AC-5). Re-exported here because this is the module the
 * WebSocket server and its tests already reach for.
 */
export { attachSubscriber };

/**
 * Route a client frame to the agent running that Task (tasks TASK-014 / TASK-022).
 *
 * Tenancy: the Workspace comes from the subscriber's *signed ticket*, never from the frame, and
 * a frame naming a different Task than the ticket authorized is refused — so a client can only
 * ever steer the one agent it was granted (Principle V). A board-channel subscriber has no
 * `taskId` in its claims and therefore cannot steer anything.
 */
export async function handleClientFrame(
  deps: Pick<WsServerDeps, "registry">,
  claims: StreamTicketClaims,
  raw: unknown,
): Promise<
  | { ok: true; action: "input" | "stop" | "permission" | "widget_response" }
  | { ok: false; error: ClientFrameError }
> {
  const parsed = taskInputSchema.safeParse(safeJson(raw));
  if (!parsed.success) return { ok: false, error: "frame_malformed" };
  const frame = parsed.data;

  if (!claims.taskId || frame.taskId !== claims.taskId) {
    return { ok: false, error: "frame_not_authorized" };
  }

  if (frame.kind === "stop") {
    const stopped = await deps.registry.stop(claims.workspaceId, frame.taskId);
    return stopped ? { ok: true, action: "stop" } : { ok: false, error: "agent_not_running" };
  }
  if (frame.kind === "permission") {
    // The operator's answer to something the agent asked (issue #58, AC-4), routed the same way
    // as input and stop and under the same tenant key: a client can only ever answer for the
    // one agent its ticket authorized (Principle V).
    const answered = await deps.registry.respondPermission(
      claims.workspaceId,
      frame.taskId,
      frame.requestId,
      frame.optionId,
    );
    if (answered === "answered") return { ok: true, action: "permission" };
    // Four refusals, four things to say. An answer that arrived a moment after the deadline
    // settled the request must not be reported as an agent that is no longer running — the
    // agent is mid-turn, streaming into the terminal the operator is looking at.
    return { ok: false, error: PERMISSION_FRAME_ERROR[answered] };
  }
  if (frame.kind === "widget_response") {
    // The operator's answer to something the agent drew. Same route, same tenant key, same ack
    // shape as a permission — the two are the same act with different vocabulary.
    const answered = await deps.registry.respondWidget(claims.workspaceId, frame.taskId, {
      widgetId: frame.widgetId,
      values: frame.values,
      text: frame.text ?? null,
    });
    if (answered === "answered") return { ok: true, action: "widget_response" };
    return { ok: false, error: WIDGET_FRAME_ERROR[answered] };
  }
  const accepted = await deps.registry.send(claims.workspaceId, frame.taskId, frame.data);
  return accepted ? { ok: true, action: "input" } : { ok: false, error: "agent_not_running" };
}

export type ClientFrameError =
  | "frame_malformed"
  | "frame_not_authorized"
  | "agent_not_running"
  | "permission_not_pending"
  | "permission_option_unknown"
  | "permission_unsupported"
  | "widget_not_pending"
  | "widget_option_unknown";

/** Why a permission answer did not land, in the vocabulary the ack carries. */
const PERMISSION_FRAME_ERROR: Record<
  Exclude<PermissionAnswerResult, "answered">,
  ClientFrameError
> = {
  no_agent: "agent_not_running",
  no_permission_channel: "permission_unsupported",
  not_pending: "permission_not_pending",
  option_not_offered: "permission_option_unknown",
};

/**
 * Why a widget answer did not land. `no_widget_channel` reports as `agent_not_running` on
 * purpose: a run old enough to have no widget channel has no widget on screen either, so the
 * honest thing to tell the operator is that nothing is listening — not that their answer was
 * about the wrong option.
 */
const WIDGET_FRAME_ERROR: Record<Exclude<WidgetAnswerResult, "answered">, ClientFrameError> = {
  no_agent: "agent_not_running",
  no_widget_channel: "agent_not_running",
  not_pending: "widget_not_pending",
  option_unknown: "widget_option_unknown",
};

function safeJson(raw: unknown): unknown {
  const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? decodeUtf8(raw) : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * How long to wait after boot before the first reclaim sweep (see `reconcile.ts`). Long enough
 * that a legitimate Inngest redrive — which re-registers with `agentRegistry` the moment it
 * resumes — has a real chance to land first.
 */
const RECONCILE_GRACE_MS = 20_000;

/**
 * How often to sweep after that.
 *
 * The sweep used to happen once, at boot, and that was the bug: it answers only "was something
 * orphaned by the process before me", never "has something been orphaned since". A run that died
 * two hours into a process left its Task showing `running`, with an input box answering "No agent
 * is running", until somebody restarted the orchestrator. Sweeping on a timer is what closes it.
 *
 * A minute is cheap — one indexed select over `running` Tasks, which is a handful of rows — and
 * the delay an Owner actually feels is dominated by `RECLAIM_STALE_MS`, the quiet period a Task
 * has to serve before this will touch it at all.
 */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * What one sweep needs, which is less than the server has.
 *
 * `Pick<WsServerDeps, ...>` would drag the whole `AgentRegistry` class in, and every arm here
 * asks it exactly one question — the same `Pick<AgentRegistry, "get">` the reconcilers themselves
 * take. A `WsServerDeps` satisfies this structurally, so the production call site is unchanged.
 */
export interface SweepDeps {
  db: Db;
  registry: Pick<AgentRegistry, "get">;
  dockerHost: Executor;
}

/**
 * One pass of the reconciliation sweep, in two phases: everything that writes a verdict onto a
 * Task row, and then the reaper that reads those verdicts off the host's containers.
 *
 * A named function rather than a closure inside the server, so the wiring itself can be driven in
 * a test with an injected clock (`reap.test.ts`, "the sweep it is an arm of"). That test exists
 * because the arm below was missing for a whole round while every unit test around it passed:
 * `reportStrandedParks` was written, tested and correct, this list had three entries, and the
 * container leak it closes stayed open in production the entire time.
 *
 * **The phases are ordered, and the concurrency they replaced was itself a defect.** The first
 * three start from Task rows and write verdicts onto them; the reaper starts from the *host* and
 * reads those same rows as evidence of life — it is a reader of what the other three write. Run
 * inside one `Promise.all` it raced them, and lost: reproduced on Docker 29.7.2, where the sweep
 * that stamped a stranded park read the row before the stamp landed and reasoned from a table that
 * was already out of date. A sweep runs every sixty seconds, so the cost of that was survivable —
 * which is exactly why it has to be a decision rather than an accident. Ordering costs one extra
 * round trip to a local SQLite file and makes each pass act on the table as that pass left it.
 *
 * **Ordering is not the same as removing in the same pass, and it never is.** `reap.ts` waits a
 * quiet window out from a Task row's own last write whatever that row says, so a verdict any of
 * the three above stamps on this pass is acted on ten minutes later, not now. That used not to
 * hold for `reclaimOrphanedRuns` — the `failed` row it writes was reapable with no cushion at all,
 * which is how a `running` Task inside a long `executor-preflight` had its live container removed
 * by the same sweep call that condemned it, reproduced here in one pass. Verified live end to end
 * for the park case: first sweep stamps and keeps, a later sweep removes.
 *
 * What the ordering still buys is that the reaper reads a table this pass has finished writing
 * rather than one it is racing — reproduced on Docker 29.7.2, where the concurrent version read a
 * row before the stranded-park stamp landed and reasoned from a table already out of date.
 *
 * The three inside phase one stay concurrent: they select disjoint sets of rows (`running`,
 * `review` with no reason, `parked` with no reason) and none of them reads what another writes.
 *
 * Each phase keeps its own `catch`, and that is load-bearing rather than tidy. A failed sweep must
 * never stop the next one — the reasons these throw (a locked database, a transient driver error)
 * are exactly the transient kind — and under the single shared `catch` this used to have, a
 * throwing tell would now also skip the reaper for that pass, so making the phases sequential
 * would have quietly cost coverage.
 */
export async function reconcileSweep(
  deps: SweepDeps,
  now: () => Date = () => new Date(),
): Promise<void> {
  await Promise.all([
    reclaimOrphanedRuns(deps.db, deps.registry, hub, now).then((count) => {
      if (count > 0) {
        console.log(`[solow/orchestrator] reclaimed ${count} orphaned running task(s)`);
      }
    }),
    // The second way a run goes missing: a Task at the gate whose decision was recorded and never
    // applied, because the run holding the wait is gone.
    reportStrandedReviews(deps.db, deps.registry, hub, now).then((count) => {
      if (count > 0) {
        console.log(`[solow/orchestrator] ${count} review decision(s) were never applied`);
      }
    }),
    // And the third, which nothing was watching at all: a run inside the five-hour park sleep that
    // never woke. The reaper below cannot reach that container on its own — every signal it reads
    // says a run is coming back — so this is the sweep that has to speak before it looks.
    reportStrandedParks(deps.db, deps.registry, hub, now).then((count) => {
      if (count > 0) {
        console.log(`[solow/orchestrator] ${count} parked task(s) never resumed`);
      }
    }),
  ]).catch(sweepFailed);

  /*
   * Then the container a lost run was running in (issue #96). An arm of this sweep rather than a
   * boot-only hook, because boot-only is exactly the incident `RECONCILE_INTERVAL_MS` above
   * documents — and a container leaked at 13:54 holds its CPU reservation and its memory ceiling
   * for the same ninety minutes, where nobody can even see it from the board.
   *
   * The inference runs the other way from the three above: it starts at the host and asks whether
   * a container still belongs to something, so the database and the registry are evidence of life
   * rather than a list of things to kill. It resolves rather than throwing on a host with no
   * Docker — see `reap.ts`, and the `catch` here, which would otherwise print a failed sweep every
   * sixty seconds for ever.
   */
  await reapOrphanedContainers(deps.dockerHost, deps.db, deps.registry, now)
    .then((count) => {
      if (count > 0) {
        console.log(`[solow/orchestrator] removed ${count} orphaned executor container(s)`);
      }
    })
    .catch(sweepFailed);
}

function sweepFailed(cause: unknown): void {
  console.error("[solow/orchestrator] reconciliation sweep failed:", cause);
}

/**
 * Long-lived orchestrator process (Decision 0002): hosts the WebSocket hub and the Inngest
 * functions. Serverless-style Next.js cannot hold these, so they run here.
 */
export function startWebSocketServer(
  port = orchestratorEnv().SOLOW_WS_PORT,
  deps: WsServerDeps = defaultWsDeps(),
) {
  setTimeout(() => {
    void reconcileSweep(deps);
    setInterval(() => void reconcileSweep(deps), RECONCILE_INTERVAL_MS);
  }, RECONCILE_GRACE_MS);

  return Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const { pathname } = new URL(req.url);
      // The two HTTP routes the durable engine needs (Decision 0004), handled before the
      // upgrade check below so they never fall into the "websocket only" 426: `/events` is
      // where `orchestrator-client.ts`'s `emit()` lands, and `/api/inngest` is what the
      // Inngest Dev Server (or, hosted, Inngest Cloud) polls to discover and invoke `taskRun`.
      if (pathname === "/events" && req.method === "POST") return handleEventPost(req);
      if (pathname === "/api/inngest") return inngestServeHandler(req);
      if (pathname === "/announce" && req.method === "POST") return handleAnnouncePost(req, deps);
      if (pathname === "/probe-agent" && req.method === "POST") return handleProbePost(req, deps);

      const auth = authorizeUpgrade(req.url, deps);
      if (!auth.ok) return new Response(auth.error, { status: auth.status });
      if (server.upgrade(req, { data: auth.data })) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      async open(ws) {
        ws.data.unsubscribe = await attachSubscriber(deps, ws.data, (msg) =>
          ws.send(JSON.stringify(msg)),
        );
      },
      async message(ws, raw) {
        const result = await handleClientFrame(deps, ws.data.claims, raw);
        // Acknowledge either way: the terminal needs to tell the operator that their input
        // went nowhere (no agent running) rather than appear to have been accepted.
        ws.send(JSON.stringify({ kind: "ack", ...result }));
      },
      close(ws) {
        ws.data.unsubscribe?.();
      },
    },
  });
}
