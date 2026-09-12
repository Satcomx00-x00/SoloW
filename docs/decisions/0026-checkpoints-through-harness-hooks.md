# 0026 — Workflow checkpoints are enforced through the harness's own hooks, relayed over the filesystem

**Status:** Accepted · **Date:** 2026-09-12 · **Deciders:** Architecture
**Builds on:** [0003](./0003-agent-connection-protocol.md), [0023](./0023-docker-executor-cli.md),
[0024](./0024-agent-libraries-loading.md) · **Enables:** [F03](../features/F03-workflow-designer.md) (checkpoints)

## Context

A review of a "Plan, then build" run found that the Build Step ran a database migration,
regenerated a lockfile and was one command from pushing, and that the only human decision in the
pipeline came afterwards, on a diff of four hundred files. Between "the harness may do anything
inside its worktree" (`acceptEdits`) and "a person judges the whole change at the end"
(Principle I) the product had nothing to say.

Claude Code in stream-json mode decides permissions inside itself and offers no channel to ask
an operator on; `acp-runner.ts` has such a channel, and SoloW already surfaces and answers ACP
permissions with an inbox that refuses when nobody answers. What stream-json does have is
**hooks**: a `PreToolUse` command the CLI runs before each tool call, handed the call as JSON on
stdin, whose JSON on stdout can allow or deny — and which runs under `bypassPermissions` too.

The hook runs where the harness runs: on the host, or inside a container whose network the
Executor Profile chose and which may have no route to the orchestrator at all.

## Options considered

1. **A hook that calls the orchestrator over HTTP.** Needs a route from every executor to the
   orchestrator, a token in the harness's environment (which the harness's own shell inherits),
   and `curl` in every image.
2. **A hook that answers `ask` and lets the CLI's permission prompt tool carry it.** Headless
   `-p` mode cannot honour `ask`; the call falls through to the normal flow. Not a checkpoint.
3. **A hook that relays over a directory the executor already shares.** The Docker executor
   already binds one per-Task host directory into the container for transcripts
   ([0025](./0025-history-retention.md)); a second one, at its own path, gives a POSIX `sh` hook and
   the orchestrator a mailbox: `<id>.request` in, `<id>.answer` out, both written atomically.

## Decision

Option 3. A Step's `checkpoints` are `{ on: "command" | "write", match, label }` rules, on the
Step because a Step is a harness launch. The stream-json runner writes `hook.sh` into the Task's
checkpoint store, passes the CLI `--settings` inline naming it on the tools the rules watch,
watches the store, applies the rules to each request — the command line, or the path written;
never the tool call's contents — and answers at once with no opinion when nothing fires. When a
rule fires it publishes a `permission_request` on the run's stream, waits through the same
`PermissionInbox` ACP uses, and writes the CLI's allow-or-deny. Nobody answering is a refusal
that tells the harness to leave the action undone and report it as an open item. The hook's own
timeout outlasts the operator's deadline, because past it the CLI proceeds as if there were no
hook — a slow answer must never become a silent grant.

Other protocols keep the list and the run's log says it was not enforced, the way an unsupported
model pin is reported rather than dropped.

## Consequences

- A person is asked *before* the migration runs, the dependency changes, the branch is pushed —
  on the Task page, on the same card an ACP permission uses, with the footer pointing at it.
- This is a control on an honest harness's autonomy, not a security boundary: the hook runs as
  the harness's own user. The review gate on the diff remains the boundary (Principle I);
  checkpoints decide what reaches it.
- Every watched tool call pays a round trip through the store — well under a second on a host,
  and the matcher is derived from the rules so a command-only Step installs no hook on edits.
- A Task's checkpoint store is removed with its transcripts at retention.
