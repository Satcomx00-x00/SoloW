# 0024 — One library, three hand-overs: how each agent runtime is given MCP servers and Skills

**Status:** Accepted · **Date:** 2026-09-06 · **Deciders:** Architecture
**Builds on:** [0003](./0003-agent-connection-protocol.md), [0017](./0017-worktree-git-rpc.md),
[0023](./0023-docker-executor-cli.md) · **Enables:** [F24](../features/F24-agent-libraries.md)

## Context

[F24](../features/F24-agent-libraries.md) keeps MCP servers and Skills in one place and loads them
into every agent SoloW runs. SoloW drives three runtimes ([0003](./0003-agent-connection-protocol.md)),
and they take the same two things three different ways:

- **Claude Code in stream-json mode** takes `--mcp-config <file|json>` for servers and
  `--plugin-dir <dir>` for a plugin, whose `skills/<name>/SKILL.md` are Skills. It creates its
  own worktree (`--worktree`, [0017](./0017-worktree-git-rpc.md)), so SoloW cannot put files
  inside the checkout the agent works in before the agent exists.
- **ACP agents** (opencode, Claude Code over ACP) take servers on `session/new.mcpServers` — the
  protocol has a channel for exactly this — and have no channel for Skills: they discover them as
  files in their working directory, under a directory each runtime scans (`.opencode/skill/`,
  `.claude/skills/`). SoloW provisions that worktree itself, so it *can* write there.
- A **pass-through CLI** takes neither.

The Docker executor ([0023](./0023-docker-executor-cli.md)) adds one constraint: whatever is
written has to be under a path the container mounts, at the same absolute path.

## Decision

**The library stores what an item is; a per-runtime materializer decides how the agent is told.**
`materializeLibraries` (`apps/orchestrator/src/agent/libraries.ts`) takes the resolved libraries,
the leg's protocol and catalog key, and returns extra arguments, ACP `mcpServers`, and notices:

1. **Claude Code** — `mcp.json` and a generated plugin (`.claude-plugin/plugin.json` +
   `skills/`) under the Task's own directory (`<worktreeRoot>/<taskId>/.solow-libraries/`), passed
   as `--mcp-config` and `--plugin-dir`. That directory is the Task's jail and is bind-mounted on
   the Docker driver, and it is outside the worktree the agent creates — nothing reaches the diff.
2. **ACP** — servers as `session/new.mcpServers` objects (stdio and http both; env and headers as
   the wire's name/value lists). Skills written into the provisioned worktree under the directory
   the catalog key implies, and that directory added to the worktree's `info/exclude`, so `git
   status` and every diff SoloW takes stay clean without touching the repository's own ignore
   files.
3. **Anything else** — nothing, and a notice in the transcript naming the runtime, rather than an
   argument the binary would refuse or a file nothing reads.

**Resolution happens inside the durable step that spawns the agent, and is never memoized.**
`loadAgentLibrariesForRun` decrypts the Secrets a server references; the same rule as the Agent
Profile's credential ([Principle IV](../../.specify/memory/constitution.md)). A Secret that is gone fails
the round by name — a server started without its token fails later, inside the agent, with a
message about the wrong thing.

**Files are written by the orchestrator process, with `node:fs`, into the mounted Task directory.**
The executor-boundary audit holds process spawning and Bun's host APIs to `executor/local.ts`; it
does not hold `node:fs`, and `ExecutorFs` is jailed to relative paths inside the Task directory,
which cannot read a directory-backed Skill kept elsewhere on the host. Writing host-side into a
path both drivers mount is what makes one code path serve both.

## Consequences

- Adding a runtime means adding a branch to `materializeLibraries` — and, if it takes neither
  arguments nor `session/new`, a notice. Nothing in the library or the API changes.
- A directory-backed Skill is copied at launch. An edit to it after the agent started is the
  next run's Skill, not this one's.
- The ACP Skills directory is inside the worktree. It is excluded from git, so a commit made by
  SoloW never carries it; an agent that runs `git add -f` could still add it, which is the same
  trust the worktree already extends to the agent.
- A pass-through CLI agent gets no libraries. Making one take them is a runtime question, not a
  library one, and this record says so rather than silently loading nothing.

## Alternatives considered

- **Writing `.mcp.json` / `.claude/skills` into the repository checkout.** Claude Code would ask
  for trust on project-scoped servers, and every file would be in the agent's diff. Rejected.
- **A remote git URL as a Skill source.** A clone inside the run loop, with the network and the
  credentials that implies. The operator's checkout, pointed at, is the same thing without it.
- **Passing servers to Claude Code inside the plugin's `.mcp.json`.** Works, but `--mcp-config` is
  explicit and independent of plugin loading; two channels for one thing were not worth the
  coupling.
