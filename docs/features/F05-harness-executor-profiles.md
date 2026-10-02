# F05 — Harness & Executor Profiles

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-22

## Summary

Profiles are reusable, named configurations that make harness work repeatable and consistent.
A **Harness Profile** captures how a particular harness should be run; an **Executor Profile**
captures where it should run. Tasks and Workflow Steps reference Profiles rather than
re-specifying configuration each time.

## Jobs served

- **J1 — Parallelise safely.**
- **J6 — Control cost.**
- **J7 — Offload heavy work.**

## User stories

- As a Team Lead, I want to define standard harness configurations once, so my team uses them
  consistently.
- As a user, I want to pick a harness and a runtime for a Task from saved options, so I do
  not reconfigure everything each time.
- As an Operator, I want to define where harnesses run, so heavy work goes to the right
  machines.

## Harness catalog (issue #10)

Which harnesses a Harness Profile can name is data, not an enum. `agent_catalog` is a
Workspace-scoped table — `packages/db/src/schema.ts` → `harnessCatalog` — of rows shaped like:

```
agent_catalog (id, workspaceId, key, displayName, protocol, command, argsTemplate,
               installHint, minVersion, subscriptionEnvVar, meteredEnvVar, capabilities)
```

A Harness Profile's `agentCatalogId` points at one of these rather than switching on a closed
`harnessKind` string. **Adding a supported harness is a catalog row plus a Profile pointing at it,
not a change to application code** — the schema, the DAL, and the billing guard all read the
catalog row rather than a literal.

Since issue #10/#58, that row no longer has to come from a seed: `profile.agentCatalog.create`
(`apps/web/src/server/dal/profile.ts` → `createHarnessCatalogEntry`) lets an Owner declare one
from Settings → Harness profiles → "Add a custom harness", refused on a key already taken in the
Workspace. This is what makes the `acp` protocol reachable at all — `acp-runner.ts` already
implements the full `session/request_permission` round trip the inline elicitation card needs,
but until an Owner could add an `acp`-protocol row, no Harness Profile could ever point at one.

Two fields carry the weight:

- **`subscriptionEnvVar` / `meteredEnvVar`.** `resolveHarnessRunEnv` (`packages/core/src/billing.ts`)
  strips whichever variable the *running* catalog row names, not a hardcoded
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` pair. That is what keeps the billing-integrity
  guarantee (Principle IV) true once a second harness's row exists.
- **`protocol`.** Names how the harness is meant to be driven — `claude_code_stream_json` today,
  `acp` once issue #58 lands, `cli_passthrough` once issue #21 does. Naming a protocol and
  *driving* it are different things: `apps/orchestrator/src/harness/protocols.ts` lists which
  protocols actually have a runner (today: one), and the Task lifecycle fails a Task pointed at
  an undriven protocol before a harness starts, rather than crashing inside a runner never built
  to speak it — the same pattern F07 uses for an Executor kind with no driver yet.

**The version pin (`minVersion`, migration `0042`).** A row may name the oldest build of its
harness a run accepts. It is checked against the ACP handshake's `agentInfo.version`, straight
after `initialize` and before any session is opened (`@solow/acp` → `requireMinimumVersion`), both
by a real run and by Settings' "Test" probe — which also shows the build that answered. A harness
below the pin, or one that does not report a version while a pin is set, fails the Task with the
refusal itself as its `failureReason` (e.g. `opencode 1.17.2 is older than 1.18.33, the oldest
version this build supports — upgrade it (…)`), quoting the row's `installHint`. Only ACP can be pinned: stream-json and plain CLIs have no handshake that names a
build, so the field is ignored for them. The seeded `opencode` row is pinned to **1.18.33**, the
build verified end to end; to raise it, change `minVersion` in
`packages/db/src/harness-catalog-defaults.ts` and add a migration that updates existing rows the
way `0042` does (guarded on the old value, so a Workspace's own pin is kept). The pin is checked
against the real bundled binary by `apps/orchestrator/src/harness/version-pin.test.ts` on every
test run (`SOLOW_TEST_OPENCODE_BIN=<path>` points it at another build).

**opencode is installed by SoloW, not by the operator.** `opencode-ai` is an exact dependency of
the orchestrator and of the published `@satcomx00-x00/solow`, so `bun install` or `npx` brings the
pinned build with everything else. The package's postinstall is never needed — a current npm
blocks it and Bun skips it — because the executable already ships inside a per-platform optional
dependency (`opencode-linux-x64`, …), fetched from the registry with no third-party download.
The local Executor swaps a bare `opencode` in a catalog row for that binary at spawn
(`apps/orchestrator/src/executor/bundled-binaries.ts`, choosing the glibc/musl and AVX2/baseline
build the way the postinstall would); an absolute path or any other command is left alone, and a
missing bundled copy falls back to PATH. The Docker Executor is unaffected: a container is another
machine, so its image carries its own harness. **The dependency and the pin move together** —
bump `opencode-ai` in both `package.json` files, `minVersion` in the defaults and a migration in one
change; `bundled-binaries.test.ts` fails when the installed build and the seeded pin differ.

Every Workspace is still seeded with a `claude_code` catalog entry the moment it exists — at
sign-up (`apps/web/src/server/auth/auth.ts`) and in the dev/test seed alike
(`packages/db/src/harness-catalog-defaults.ts`) — so a Harness Profile is always creatable without
an Owner adding anything first; the seed guarantees a floor, the create mutation removes the
ceiling.

## The configuration a harness runs against (Decision 0027)

A Task's harness runs against a **blank, app-owned configuration**, never the operator's
machine-level one. At launch the run is given `$HOME` — and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_CACHE_HOME`, `XDG_STATE_HOME` and `CLAUDE_CONFIG_DIR` with it — pointing at a directory
SoloW made for that Task (`<SOLOW_WORKTREE_ROOT>/<taskId>--harness-home`), so `~/.claude/`,
`~/.claude.json`, `$HOME/CLAUDE.md`, the operator's `settings.json`, their user-level MCP servers
and their user-level Skills are all somewhere the harness never looks. Claude Code is additionally
launched with `--setting-sources project,local`, which omits the user tier in argv as well.

Three boundaries define what this does and does not mean:

- **Configuration discovery is isolated; the environment is not.** `PATH`, `LANG`, `TERM` and the
  proxy variables reach the harness unchanged — they are what let it run at all — and an Executor
  Profile's own `env` (FR-5) still applies over them.
- **Repository-level configuration stays.** A `CLAUDE.md` or a `.claude/` committed in the checkout
  is the *project's* configuration and a Task is supposed to obey it. Only the user/machine tier is
  neutralised.
- **What the app wants loaded still arrives explicitly** — MCP servers and Skills from the
  libraries as `--mcp-config`/`--plugin-dir` ([F24](./F24-harness-libraries.md)), and a Step's
  checkpoint hook as `--settings` ([F03](./F03-workflow-designer.md)). The home is seeded empty
  precisely so there is one source of truth for that.

The directory is per-Task rather than per-round, so a resumed conversation still finds whatever its
harness cached, and it is removed with the Task's worktrees and transcripts by the retention sweep
([F11](./F11-sessions-conversations.md), Decision 0025).

An Executor Profile cannot undo this: the isolation is applied *after* the profile's `env`, so a
profile that names `HOME` is accepted at the API (nothing stored becomes invalid) and ignored at
launch. Two things are deliberately **not** closed, and Decision 0027 records both: a custom
harness's `agent_catalog.argsTemplate` is appended last and can therefore add a `--settings` of its
own, and the harness's own shell can read its environment and the filesystem the executor gives it.
None of this is a sandbox — the container Executor ([F07](./F07-execution-environments.md)) is what
a Task that must not reach the host is pointed at.

## Harness Configs (Decision 0028)

The configuration a harness *does* get lives in the app. A **Harness Config** is the harness's own
JSON — Claude Code's `settings.json`, opencode's `opencode.json` — stored per Workspace and edited
in Settings → Harness configs, where it can be created, edited, duplicated, exported to a file and
imported from one. A Harness Profile selects at most one config written for its harness; none means
the harness's own defaults.

At launch the selected config is handed over without touching any file: Claude Code receives it as
`--settings` (with a Step's checkpoint hook merged over it, never dropped), opencode as
`OPENCODE_CONFIG_CONTENT`. Both work identically on the local and container Executors. A config may
not carry a credential or name a variable SoloW owns — billing, configuration discovery — and is
refused, key by key, when it tries; the Profile's Secret is where a credential belongs.

## Functional requirements

### Harness Profiles
- **FR-1** A user can create a Harness Profile specifying: the catalog harness it runs (see
  above), its Authentication Mode (see [F06](./F06-authentication-billing.md)), its tool-use
  approval policy, and its concurrency limit. The approval policy shipped 2026-08-22 as
  **permission mode**, carried to the harness as the vendor CLI's own `--permission-mode`:
  - `bypassPermissions` (**default**, decided 2026-08-22) — it never asks.
  - `acceptEdits` — the harness edits inside its worktree and asks for everything else.
  - `plan` — it may read and reason but not change anything.

  The default is the permissive one, and that is the decision rather than an oversight. SoloW runs a harness **headless**, and the stream-json
  protocol has no channel to ask an operator on (`claude-code-runner.ts` documents this: the
  review gate, not a prompt nobody will see, is the safety boundary). So under `acceptEdits`
  every shell command and every fetch is refused by a prompt with no answerer, and a Task needing
  either stalls partway through — observed with a harness asking for `pip index versions` until it
  gave up. `bypassPermissions` is the answer, and what bounds it is the worktree the harness runs
  in plus the review gate that still holds every change before it reaches a branch (Principle I).
  The setting means the same thing on ACP, by different mechanics: that protocol *has* a request
  channel, so `bypassPermissions` there answers each request immediately with the narrowest allow
  the harness offered, published and logged as decided by `policy` — a run where nobody looked must
  never read afterwards as one where somebody did. Immediately, not on the deadline: a deadline is
  how long a person gets, and waiting one out for a decision nobody is coming to make is the same
  stall in slower clothing. Any other mode leaves ACP on the deployment's own unattended posture
  (`SOLOW_ACP_UNATTENDED_PERMISSION`), which still refuses unless a deployment named
  otherwise.
- **FR-2** A user can create, edit, duplicate, and delete Harness Profiles within a Workspace.
  Editing shipped 2026-08-22 (`profile.agent.update`) for the three fields that describe how a
  Profile runs — name, concurrency cap, permission mode. The harness it points at, its auth mode
  and its Secret are fixed at creation: those are what a Profile *is*, and changing them under
  Tasks that already reference it would rewrite what finished runs meant.
- **FR-2a** A Harness Profile can select a Harness Config for its harness, changeable at any time;
  a config is refused for deletion while a Profile selects it (Decision 0028).
- **FR-3** A Harness Profile can be referenced by many Tasks and Workflow Steps.
- **FR-4** Editing a Harness Profile affects future Sessions; Sessions already running are
  unaffected.

### Executor Profiles
- **FR-5** A user can create an Executor Profile specifying the execution environment type
  (local, container, remote, or cloud) and its configuration (see [F07](./F07-execution-environments.md)).
- **FR-6** A user can create, edit, duplicate, and delete Executor Profiles within a
  Workspace.
- **FR-7** An Executor Profile can be referenced by many Tasks.

### Use
- **FR-8** When creating or configuring a Task, a user selects one Harness Profile and one
  Executor Profile.
- **FR-9** A Profile in active use cannot be deleted without warning; the user is told which
  Tasks or Workflows depend on it.

- **FR-N1** A Harness Profile MAY pin the **model** and the **mode** its harness launches with
  (issue #94). Both are nullable and null is the ordinary value: it means "whatever the harness
  chooses". A default written into the code would be a model id that rots the first time a
  provider retires one, and a stale pin fails at launch rather than at the moment somebody could
  have fixed it.
- **FR-N2** A pin travels only to a protocol that can express it — `--model` for the stream-json
  CLI, `session/set_mode` for ACP — and a mode id is only ever one the harness itself advertised.
- **FR-N3** WHERE a protocol cannot select what a Profile pinned, THE SYSTEM SHALL say so in the
  run's own log and use the harness's choice. It SHALL NOT substitute silently: a run that used a
  different model than the Profile asked for, with the Profile still reading as though the pin
  held, is the failure this rule exists to prevent.
- **FR-N4** Each ACP run refreshes `agent_catalog.capabilities` from what the harness advertised
  at its handshake — the cache **replaces** rather than merges, so a retired model actually
  leaves it, and a harness that advertised nothing leaves the cache alone, so silence never
  blanks what an earlier run learned. The pin fields in Settings suggest from this cache
  (datalist over free text — present after a first run, empty before one, never claimed
  complete).
- **FR-N5** A Profile whose pin the harness's last handshake no longer lists is marked in
  Settings — judged only when the cache says anything, so "never ran" does not read as
  "retired". The mark is the fix-it-early half of FR-N3's never-substitute rule.

## Non-functional requirements

- **NFR-1** Profiles are Workspace-scoped and shareable across all Issues and Tasks in that
  Workspace.
- **NFR-2** A Profile's configuration is validated when saved so misconfigurations are
  caught before a Task runs.

## States & rules

- Profiles are reusable building blocks defined at the Workspace level.
- A Task binds exactly one Harness Profile and one Executor Profile at launch time.
- Concurrency limits set on a Harness Profile are enforced during orchestration
  (see [F04](./F04-harness-orchestration.md), [F06](./F06-authentication-billing.md)).

## Edge cases & failure handling

- If a referenced Profile becomes invalid (for example, a removed credential), Tasks using
  it are prevented from launching with a clear reason until it is fixed.
- Deleting a Harness Profile (FR-2, FR-9) is refused while a Task, a Workflow Step, or a
  Session's usage record still references it — all three are foreign keys, so nothing is ever
  silently orphaned. The refusal names what still holds it (e.g. "Used by 3 tasks, 1 past
  session") and is shown disabled before the Owner tries, not only after the server refuses
  (`profile.agent.delete`, `harness-profiles-section.tsx`). Deleting a Profile never touches the
  Secret it spends — only the binding between them.

## Out of scope

- The mechanics of each execution environment, specified in [F07](./F07-execution-environments.md).

## Related

- [F04 — Multi-Harness Orchestration](./F04-harness-orchestration.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F07 — Execution Environments](./F07-execution-environments.md)
