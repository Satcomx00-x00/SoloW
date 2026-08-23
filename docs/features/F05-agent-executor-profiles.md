# F05 — Agent & Executor Profiles

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-22

## Summary

Profiles are reusable, named configurations that make agent work repeatable and consistent.
An **Agent Profile** captures how a particular agent should be run; an **Executor Profile**
captures where it should run. Tasks and Workflow Steps reference Profiles rather than
re-specifying configuration each time.

## Jobs served

- **J1 — Parallelise safely.**
- **J6 — Control cost.**
- **J7 — Offload heavy work.**

## User stories

- As a Team Lead, I want to define standard agent configurations once, so my team uses them
  consistently.
- As a user, I want to pick an agent and a runtime for a Task from saved options, so I do
  not reconfigure everything each time.
- As an Operator, I want to define where agents run, so heavy work goes to the right
  machines.

## Agent catalog (issue #10)

Which agents an Agent Profile can name is data, not an enum. `agent_catalog` is a
Workspace-scoped table — `packages/db/src/schema.ts` → `agentCatalog` — of rows shaped like:

```
agent_catalog (id, workspaceId, key, displayName, protocol, command, argsTemplate,
               installHint, subscriptionEnvVar, meteredEnvVar, capabilities)
```

An Agent Profile's `agentCatalogId` points at one of these rather than switching on a closed
`agentKind` string. **Adding a supported agent is a catalog row plus a Profile pointing at it,
not a change to application code** — the schema, the DAL, and the billing guard all read the
catalog row rather than a literal.

Since issue #10/#58, that row no longer has to come from a seed: `profile.agentCatalog.create`
(`apps/web/src/server/dal/profile.ts` → `createAgentCatalogEntry`) lets an Owner declare one
from Settings → Agent profiles → "Add a custom agent", refused on a key already taken in the
Workspace. This is what makes the `acp` protocol reachable at all — `acp-runner.ts` already
implements the full `session/request_permission` round trip the inline elicitation card needs,
but until an Owner could add an `acp`-protocol row, no Agent Profile could ever point at one.

Two fields carry the weight:

- **`subscriptionEnvVar` / `meteredEnvVar`.** `resolveAgentRunEnv` (`packages/core/src/billing.ts`)
  strips whichever variable the *running* catalog row names, not a hardcoded
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` pair. That is what keeps the billing-integrity
  guarantee (Principle IV) true once a second agent's row exists.
- **`protocol`.** Names how the agent is meant to be driven — `claude_code_stream_json` today,
  `acp` once issue #58 lands, `cli_passthrough` once issue #21 does. Naming a protocol and
  *driving* it are different things: `apps/orchestrator/src/agent/protocols.ts` lists which
  protocols actually have a runner (today: one), and the Task lifecycle fails a Task pointed at
  an undriven protocol before an agent starts, rather than crashing inside a runner never built
  to speak it — the same pattern F07 uses for an Executor kind with no driver yet.

Every Workspace is still seeded with a `claude_code` catalog entry the moment it exists — at
sign-up (`apps/web/src/server/auth/auth.ts`) and in the dev/test seed alike
(`packages/db/src/agent-catalog-defaults.ts`) — so an Agent Profile is always creatable without
an Owner adding anything first; the seed guarantees a floor, the create mutation removes the
ceiling.

## Functional requirements

### Agent Profiles
- **FR-1** A user can create an Agent Profile specifying: the catalog agent it runs (see
  above), its Authentication Mode (see [F06](./F06-authentication-billing.md)), its tool-use
  approval policy, and its concurrency limit. The approval policy shipped 2026-08-22 as
  **permission mode**, carried to the agent as the vendor CLI's own `--permission-mode`:
  - `bypassPermissions` (**default**, decided 2026-08-22) — it never asks.
  - `acceptEdits` — the agent edits inside its worktree and asks for everything else.
  - `plan` — it may read and reason but not change anything.

  The default is the permissive one, and that is the decision rather than an oversight. GateControl runs an agent **headless**, and the stream-json
  protocol has no channel to ask an operator on (`claude-code-runner.ts` documents this: the
  review gate, not a prompt nobody will see, is the safety boundary). So under `acceptEdits`
  every shell command and every fetch is refused by a prompt with no answerer, and a Task needing
  either stalls partway through — observed with an agent asking for `pip index versions` until it
  gave up. `bypassPermissions` is the answer, and what bounds it is the worktree the agent runs
  in plus the review gate that still holds every change before it reaches a branch (Principle I).
  The setting means the same thing on ACP, by different mechanics: that protocol *has* a request
  channel, so `bypassPermissions` there answers each request immediately with the narrowest allow
  the agent offered, published and logged as decided by `policy` — a run where nobody looked must
  never read afterwards as one where somebody did. Immediately, not on the deadline: a deadline is
  how long a person gets, and waiting one out for a decision nobody is coming to make is the same
  stall in slower clothing. Any other mode leaves ACP on the deployment's own unattended posture
  (`GATECONTROL_ACP_UNATTENDED_PERMISSION`), which still refuses unless a deployment named
  otherwise.
- **FR-2** A user can create, edit, duplicate, and delete Agent Profiles within a Workspace.
  Editing shipped 2026-08-22 (`profile.agent.update`) for the three fields that describe how a
  Profile runs — name, concurrency cap, permission mode. The agent it points at, its auth mode
  and its Secret are fixed at creation: those are what a Profile *is*, and changing them under
  Tasks that already reference it would rewrite what finished runs meant.
- **FR-3** An Agent Profile can be referenced by many Tasks and Workflow Steps.
- **FR-4** Editing an Agent Profile affects future Sessions; Sessions already running are
  unaffected.

### Executor Profiles
- **FR-5** A user can create an Executor Profile specifying the execution environment type
  (local, container, remote, or cloud) and its configuration (see [F07](./F07-execution-environments.md)).
- **FR-6** A user can create, edit, duplicate, and delete Executor Profiles within a
  Workspace.
- **FR-7** An Executor Profile can be referenced by many Tasks.

### Use
- **FR-8** When creating or configuring a Task, a user selects one Agent Profile and one
  Executor Profile.
- **FR-9** A Profile in active use cannot be deleted without warning; the user is told which
  Tasks or Workflows depend on it.

## Non-functional requirements

- **NFR-1** Profiles are Workspace-scoped and shareable across all Issues and Tasks in that
  Workspace.
- **NFR-2** A Profile's configuration is validated when saved so misconfigurations are
  caught before a Task runs.

## States & rules

- Profiles are reusable building blocks defined at the Workspace level.
- A Task binds exactly one Agent Profile and one Executor Profile at launch time.
- Concurrency limits set on an Agent Profile are enforced during orchestration
  (see [F04](./F04-agent-orchestration.md), [F06](./F06-authentication-billing.md)).

## Edge cases & failure handling

- If a referenced Profile becomes invalid (for example, a removed credential), Tasks using
  it are prevented from launching with a clear reason until it is fixed.
- Deleting an Agent Profile (FR-2, FR-9) is refused while a Task, a Workflow Step, or a
  Session's usage record still references it — all three are foreign keys, so nothing is ever
  silently orphaned. The refusal names what still holds it (e.g. "Used by 3 tasks, 1 past
  session") and is shown disabled before the Owner tries, not only after the server refuses
  (`profile.agent.delete`, `agent-profiles-section.tsx`). Deleting a Profile never touches the
  Secret it spends — only the binding between them.

## Out of scope

- The mechanics of each execution environment, specified in [F07](./F07-execution-environments.md).

## Related

- [F04 — Multi-Agent Orchestration](./F04-agent-orchestration.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F07 — Execution Environments](./F07-execution-environments.md)
