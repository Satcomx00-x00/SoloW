# F24 — Harness Libraries: MCP servers and Skills

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-09-06

## Summary

Two libraries, kept in one place — Settings → Harnesses — and loaded into the harnesses SoloW runs:
**MCP servers** a harness can call, and **Skills** it reads before it works. An item switched on
in its library is loaded into every harness run in the Workspace; an item left off is loaded only
by the Workflow Steps that name it. The library says *what* an item is; the run loop says *how*
each harness runtime is handed it, because Claude Code and an ACP agent take it differently
([Decision 0024](../decisions/0024-agent-libraries-loading.md)).

## Jobs served

- **J1 — Parallelise safely.** Every harness starts with the same tools; a Step can add its own.
- **J3 — Design a repeatable process.** A reviewing Step loads the review checklist, a deploying
  Step the deploy runbook — as part of the Workflow, not of a prompt someone has to remember.
- **J6 — Control cost.** A server or Skill is switched off in one place and stops reaching every
  harness on the next run.

## User stories

- As an Operator, I want to register an MCP server once — with its token kept in the vault — and
  have every harness able to call it, so I stop pasting configs into harnesses.
- As a Team Lead, I want to write a Skill in SoloW, or point at the checkout where our team keeps
  them, and have harnesses read it, so our conventions travel with the work.
- As a Workflow author, I want a Step to load a Skill or a server the rest of the pipeline does
  not, so a Step is equipped for its job and nothing else.

## Functional requirements

- **FR-1** An MCP server is a name, a description and a transport: a command the harness spawns
  (stdio: command, arguments, env) or an HTTP endpoint (URL, headers). Each env variable or
  header is a literal, or a reference to a Secret of the Workspace. The value behind a reference
  is never returned by the API and is decrypted only when the harness is started.
- **FR-2** A Skill is a name, a one-line description and a source: text written in SoloW (the
  body *is* the `SKILL.md`), or a directory on the host that holds a `SKILL.md` and whatever it
  references — read fresh on every run.
- **FR-3** Each item has a Workspace-wide switch, *Load in every harness*. Switched on, it is loaded
  into every harness run, with or without a Workflow.
- **FR-4** A Workflow Step names further items — additively. It can bring an item in; it cannot
  keep a Workspace-wide one out.
- **FR-5** The run loop hands every harness what it loads in the way that harness's runtime takes it,
  and says in the transcript what was loaded — or why something could not be.
- **FR-6** Names are unique per Workspace and are slugs, because they become the key of a server
  in a config file and the directory of a Skill on the harness's side.
- **FR-7** An item a Step still names cannot be deleted; a Step cannot name an item of another
  Workspace; a server cannot reference a Secret of another Workspace.

## What ships in v1

- `mcp_server` and `skill` tables, Workspace-scoped, unique on name; `workflow_step.mcp_server_ids`
  and `skill_ids`. Behind `ff-agent-libraries` (`bun run flag enable ff-agent-libraries`), under
  the core kill switch like Workflows.
- **Bulk import** (`library.skill.scan`, `library.skill.unpack`, `library.skill.import`; Settings →
  Skills → *Import*, or a `.zip` dropped anywhere on the Skills card): point at a directory on the
  host, a repository (its archive, fetched over HTTPS — GitHub, GitLab or Gitea layouts; the
  default branch or `#ref`; public or reachable without credentials), or an archive — unpacked
  into `SOLOW_SKILLS_ROOT/<name>`, an entry naming a path outside it refusing the whole archive —
  and every directory holding a `SKILL.md`
  is listed — named and described from its frontmatter, or from the directory and its first line
  of prose when there is none — ticked for import unless the library already holds that name.
  Each import is a directory source, so the scripts, references and assets beside the `SKILL.md`
  travel with it.
- **The MCP store** (Settings → MCP servers → *Store*): a curated catalog in `@solow/core`
  (`MCP_STORE`, 30 well-known servers — GitHub and GitLab among them, plus local tools, browsers,
  documentation, search, data, cloud and productivity servers, and a gateway entry) installed with
  one click. An entry that needs a credential asks for a Secret; the install writes an ordinary
  server row, switched off. Reviewed in pull requests, never fetched from a registry at run time.
- **Remote endpoints**: the `http` transport takes any Streamable HTTP or SSE URL — a hosted
  server, or a gateway such as agentgateway's `/mcp`. A Secret in a header may carry a `prefix`
  (`Bearer `) written in front of the decrypted value at run time.
- **Defaults**: an empty library is seeded with one local server (`memory`, no network, no
  account) and one Skill (`review-checklist`), both switched off — only when the library is
  empty, so a row the operator removed stays removed.
- `library.mcp.*` and `library.skill.*` on tRPC and OpenAPI. The `library` namespace is withheld
  from the external MCP surface: a harness's token must not be able to hand that harness a new
  server or re-point one at a different credential.
- Settings → Harnesses → **MCP servers** and **Skills**: the libraries, each row with its switch,
  a form to add one. The Workflow canvas: a **Loads** block on each Step listing every item, the
  Workspace-wide ones checked and locked, the rest the Step's to tick.
- The run loop: `loadHarnessLibrariesForRun` (`@solow/db`) resolves the enabled items plus the
  Step's, inside the durable step that spawns the harness — it decrypts, so it is never memoized —
  and `materializeLibraries` (`apps/orchestrator/src/harness/libraries.ts`) hands them over per
  runtime. A referenced Secret that is gone fails the round by name.

### How each runtime is handed them

| Runtime | MCP servers | Skills |
| --- | --- | --- |
| Claude Code (stream-json) | `--mcp-config <file>` written under the Task's own directory | `--plugin-dir <dir>` — a generated plugin whose `skills/` are the Skills; nothing is written into the worktree the harness creates for itself |
| opencode (ACP) | `session/new.mcpServers` — the protocol's own channel | `.opencode/skill/<name>/SKILL.md` in the worktree SoloW provisioned, excluded from git through the worktree's `info/exclude` |
| Claude Code over ACP | `session/new.mcpServers` | `.claude/skills/<name>/SKILL.md`, excluded the same way |
| Anything else | not loaded — the transcript says so | not loaded — the transcript says so |

### What this costs, stated rather than discovered

- **A Skill kept in a directory is read on every run, from the host the orchestrator runs on.**
  On a Docker executor that directory is not mounted into the container; SoloW copies its contents
  into the Task's own directory, which is, so the harness reads a copy taken at launch.
- **No per-Harness-Profile selection.** Global or per Step. A profile that should always carry a
  server is a server switched on Workspace-wide, or a Step that names it.
- **A Step's selection is additive.** There is no way to keep a Workspace-wide item out of one
  Step; switching it off Workspace-wide and naming it on the other Steps is the way to say that.
- **Fetching a remote skills repository at launch is not a source.** A download inside the run
  loop is a network dependency inside the run loop. A repository is instead imported — its archive
  fetched into `SOLOW_SKILLS_ROOT` (default `.solow/skills`), again on the next scan — and every
  Skill found in it becomes a directory source, read from that directory like any other. Never
  cloned: the web app spawns no process (the executor boundary), and an archive needs no `git`.

## Related

- [F03 — Workflow Designer](./F03-workflow-designer.md) — where a Step names what it loads.
- [F05 — Harness & Executor Profiles](./F05-harness-executor-profiles.md)
- [F17 — Security & Secrets](./F17-security-secrets.md) — the vault the references resolve in.
- [Decision 0024 — How harnesses are handed the libraries](../decisions/0024-agent-libraries-loading.md)
