# 0003 — Integrate agents via the Agent Client Protocol (ACP)

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Architecture

> **2026-08-20:** Implemented in `packages/acp` and `apps/orchestrator/src/agent/acp-runner.ts`
> (issue #58). ACP is now a real client, not a stated intention: `initialize` → `session/new` →
> `session/prompt` → `session/update` → `session/cancel`, over newline-delimited JSON-RPC 2.0 on
> the agent's stdio. See **Implementation status** below for what landed, what stayed a vendor
> protocol and why, and what is still open.

## Context

SoloW must drive many different AI coding-agent tools (Claude Code, Codex, Gemini CLI,
and others). Integrating each one bespoke would be costly and fragile. A standard has emerged
— the **Agent Client Protocol (ACP)** — that standardises how tools connect to coding agents,
analogous to how the Language Server Protocol standardised editor tooling. It is what kandev
itself uses, and a large and growing set of agents support it.

## Decision

Integrate all agents through **ACP**, a single open standard, as the uniform boundary between
SoloW and agent tools.

## Considered options

- **Bespoke per-agent integrations** — Rejected: high cost, brittle, does not scale to many
  agents.
- **A build-your-own-agent framework** (in-process reasoning loop) — Rejected: the wrong
  layer. SoloW orchestrates *existing external agent tools*; it does not build an
  agent's reasoning loop, so frameworks for that solve a different problem.
- **ACP standard boundary (chosen)** — one interface to many agents; adding an agent is
  configuration, not engineering.

## Consequences

- Positive: broad agent support through one mechanism; orchestration is independent of any
  specific agent tool; new agents are added by configuration.
- Positive: choosing to drive external CLIs (rather than an in-process loop) is what makes
  subscription billing possible — the agent inherits the CLI's authentication
  (see [0005](./0005-subscription-authentication.md)).
- Negative: dependent on the maturity and evolution of the standard; agents differ in the
  capabilities they support (risk R-2), handled per Agent Profile.

## Implementation status

Landed with issue #58 (2026-08-20). Per acceptance criterion:

- **AC-1 — drive agents over ACP JSON-RPC on stdio.** `packages/acp` implements the client:
  `jsonrpc.ts` (framing and pending-request bookkeeping), `protocol.ts` (wire vocabulary and the
  `session/update` flattener), `capabilities.ts` (negotiation), `session.ts` (the driver). The
  process is started through the injected `SpawnFn`, which the orchestrator binds to
  `Executor.spawn` — the package never reaches the execution host itself.
- **AC-2 — negotiate, do not assume (risk R-2).** Every optional capability reads `false` when
  the agent said nothing about it. `session/load` and `session/set_mode` are only ever sent when
  the agent advertised them, a prompt carrying an unadvertised content-block type is refused
  before it is written, and a peer below the minimum protocol version fails the run naming both
  versions. The half that actually protects something is the mirror: SoloW advertises
  `fs.readTextFile`, `fs.writeTextFile` and `terminal` as **false**, and answers any such
  incoming request with `-32601`. An agent edits its own worktree with its own tools; proxying a
  filesystem through the orchestrator would widen the blast radius past the worktree for no gain.
- **AC-3 — Claude Code as one adapter among N.** `agent/runners.ts#createAgentRunner` is the one
  protocol → runner switch, and `protocols.ts` answers the availability question that the
  lifecycle asks; a test holds the two in agreement for every member of the enum.
  `claude-code-runner.ts` changed only in its comments, and its whole test file is untouched.
- **AC-4 — permissions surfaced, not granted.** `session/request_permission` becomes a
  `permission_request` event that is published on the Task channel *and* appended to
  `session_event` before anything answers it, so a request cannot be settled with nobody having
  been told. The operator answers over the existing WebSocket, through
  `AgentRegistry.respondPermission`, keyed by Workspace exactly like input and stop (Principle
  V). Its request id carries a per-run tag, because the agent's own JSON-RPC ids restart at 1 in
  every spawned process and the SPA pairs a request with its resolution across the Task's whole
  replayed history — without the tag, round two's question looked like round one's answered one
  and the operator was never shown it. Unanswered after `PERMISSION_DEADLINE_MS`, the request is
  **refused**, recorded as `decidedBy: "policy"` and said in words in the terminal: an auto-grant
  on a timer is a silent grant with a delay in front of it, and it is a wider posture than the
  `acceptEdits` it was meant to match, which stops for everything that is not a file edit. A
  deployment that wants the permissive behaviour asks for it by name
  (`SOLOW_ACP_UNATTENDED_PERMISSION=allow_once`, reaching
  `AcpRunnerOptions.unattendedPermissionPosture`); nothing gets it by leaving something unset.
  The cost is honest and accepted: an unattended run asking for something it needs ends early
  rather than proceeding without consent. The tool call's `rawInput` is never
  modelled, never logged and never put on the wire (Principle IV).
- **AC-5 — one credential.** `AcpSessionOptions.env` is handed straight to `Executor.spawn`,
  whose contract replaces rather than merges the child environment. Proven by a spawned test
  child that writes the *names* of its environment variables into the worktree.
- **AC-6 — clean cancellation.** `stop()` sends the `session/cancel` notification, waits a
  bounded grace for the in-flight prompt to answer `stopReason: "cancelled"`, then closes stdin,
  signals, and escalates to `SIGKILL` as the backstop. Every rung of that ladder is time-boxed
  and the ladder itself cannot reject the run's `outcome`: an agent that installs a `SIGTERM`
  handler and declines to exit, or a transport that fails while the child is being torn down,
  would otherwise leave the durable `agent-run-N` step waiting on a promise that never settles
  instead of classifying a failure (Principle III). A stop reports as a *completed* run, because
  the partial work still goes to review (Principle I).

Conformance is tested against a scripted peer that speaks the real protocol — in-process for
framing and negotiation, and as a spawned binary for the environment and kill paths. No test
invokes a live agent (Principle VI). `FakeAgentRunner` is retained and still drives the
lifecycle tests.

### Why `claude_code_stream_json` survives as a peer adapter

ACP is the uniform boundary **at the `AgentRunner` interface**, not a requirement that every
agent be reached through an ACP process. Claude Code's own stream-JSON mode stays a first-class
adapter for two reasons: subscription billing works through the vendor CLI's own authentication
([0005](./0005-subscription-authentication.md)), and Claude Code's ACP bridge ships as a
separate binary, so forcing it through ACP would add a dependency and a hop without changing
what the orchestrator sees. The two differ in exactly one operational detail — Claude Code makes
the Task's worktree itself (`--worktree`) and an ACP agent works in the `cwd` it is given, so
SoloW provisions it — which `agentCreatesOwnWorktree` answers in one line.

That provisioning is idempotent, and has to be: the branch name and the directory are both pure
functions of the Task id, and nothing ever deletes the branch (`cleanupWorktree` removes the
directory and leaves `solow/task-<id>` behind). A relaunch after a review rejection, a
`task.retry` after a failure and an Inngest step retry inside one run all look identical from
git's side, so `provisionWorktree` reuses the Task's existing worktree when git already has it on
the right branch and resets the branch to the base ref otherwise. A provisioning failure sets the
Task to `failed` with a reason rather than escaping the step, because a Task stuck in `running`
with nothing recorded is the one outcome an operator can neither read nor act on.

### Why an in-house client rather than the official SDK

`@agentclientprotocol/sdk` was considered and not taken. The conformance tests the Definition of
Done asks for have to exercise *SoloW's* framing, negotiation and cancellation paths, and
`Executor.ProcessHandle` exposes an `AsyncIterable` plus a flushable sink rather than WHATWG
streams — the shim would have been larger than the framing it replaced. It also keeps a new
runtime dependency out of the credential-bearing path. The cost is owning schema drift as ACP
evolves, mitigated the way `packages/claude-code` already mitigates it: passthrough schemas
everywhere, unknown update kinds yielding nothing rather than throwing, and `stopReason` read as
a string rather than an enum.

### Deliberately still open

- **Row 26 — models and modes from live data.** The handshake and `session/new` already carry
  the agent's advertised modes, and `session/set_mode` is wired and guarded; writing what was
  negotiated back to `agent_catalog.capabilities` is not done.
- **Row 76 — passthrough MCP.** `session/new` is sent with `mcpServers: []`. An agent driven by
  SoloW therefore reaches only the MCP servers it configures for itself; nothing the
  Workspace holds is passed through to it. Known and outside #58's acceptance criteria.
- **Authentication.** `initialize` negotiates `authMethods` and `NegotiatedCapabilities` carries
  them, but `AcpMethod.Authenticate` is declared and never called: the client goes straight from
  `initialize` to `session/new`. An ACP agent that requires authentication (a Gemini or Codex
  adapter with no active credential) answers `session/new` with an auth error, and the run
  reports a plain failure without naming authentication as the cause. Outside #58's acceptance
  criteria — the agents this build drives authenticate through the environment the billing guard
  shapes (Decision 0005) — but it is the first thing to add before a second vendor's adapter is
  claimed to work, and the scripted peer will need an `authMethods` script to test it.
- **Turn model.** ACP v1 offers no way to type into a running turn, so operator input is queued
  as the next `session/prompt`. `AgentHandle.send` already means "accepted", not "delivered now",
  but an operator used to Claude Code will see the reply a turn later than they expect. `send`
  waits (boundedly) for the handshake before it accepts anything, so the Task brief is always
  turn 1 — input typed while the agent process was still starting used to take that place, and
  the agent's first prompt was a steering message with no task in it.
- **Durability of a pending permission.** The inbox lives in orchestrator memory, so a restart
  loses an unanswered request and Inngest re-runs the round. That is already true of every live
  agent handle (`agent/registry.ts` says so); making a permission prompt durable is separate work.
- **Token usage.** ACP v1 defines no usage field, so each completed turn is recorded with
  `reported: false` and zero counts — visible as a gap rather than as a turn that cost nothing.
