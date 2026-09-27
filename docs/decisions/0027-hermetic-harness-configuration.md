# 0027 — A Task's harness runs against a blank, app-owned configuration

**Status:** Accepted · **Date:** 2026-09-24 · **Deciders:** Architecture
**Builds on:** [0023](./0023-docker-executor-cli.md), [0024](./0024-agent-libraries-loading.md),
[0026](./0026-checkpoints-through-harness-hooks.md) ·
**Enables:** [F05](../features/F05-harness-executor-profiles.md),
[F07](../features/F07-execution-environments.md)

## Context

A harness launched by the local Executor was handed `process.env` wholesale
(`apps/orchestrator/src/executor/local.ts`, `baseEnv()`). `HOME` therefore named the operator's
own account, and Claude Code — like every tool of its shape — reads its configuration from there:
`~/.claude/`, `~/.claude.json`, `$HOME/CLAUDE.md`, the user `settings.json`, user-level MCP
servers, user-level Skills.

Three things follow, and all three were true in production:

- **A SoloW run was not reproducible.** An operator editing a file in their home directory
  silently changed what every Task on that machine did, with nothing recorded anywhere about it.
  Two deployments of the same SoloW, same Profiles, same brief, behaved differently.
- **It contradicted the rest of the product.** [F24](../features/F24-harness-libraries.md) and
  [0024](./0024-agent-libraries-loading.md) exist precisely so that *the app* decides which MCP
  servers and Skills a run loads. A user-level `~/.claude/settings.json` sat above that decision
  and nothing in the product knew.
- **The two drivers disagreed.** The Docker executor was already hermetic
  ([0023](./0023-docker-executor-cli.md)): `CONTAINER_HOME` is a tmpfs nobody has ever configured,
  created for the container and destroyed with it. Whether a Task inherited the operator's
  configuration depended on which Executor Profile it happened to be pointed at.

What is *not* the problem is the environment in general. `PATH`, `LANG`, `TERM` and the proxy
variables are what make the harness able to run at all, and the executor contract suite asserts
that `baseEnv()` carries a `PATH` a child can actually use. Nor is repository-level configuration
a problem: a `CLAUDE.md` or a `.claude/` committed in the checkout is the *project's*
configuration, is visible to everyone who clones it, and is exactly what a Task should obey.

## Decision

**Isolate configuration discovery, not the environment, and do it in the one funnel the harness
environment already passes through.**

1. **A per-Task home the app owns.** `harnessHomePath(root, taskId)` →
   `<SOLOW_WORKTREE_ROOT>/<taskId>--harness-home`, named by the same rule as the Task's
   transcripts and checkpoint store. Under the worktree root deliberately: the Docker mount guard
   already admits that root, and the retention sweep ([0025](./0025-history-retention.md)) already
   removes everything keyed to a Task there — so it is swept with the rest and needs no bookkeeping
   of its own. Per-Task and not per-round, because round two resumes a conversation round one's
   harness may have cached something for.

2. **Seeded blank.** `apps/orchestrator/src/harness/hermetic-home.ts` creates the directory and an
   empty config directory inside it, with `node:fs` host-side — the same exemption, for the same
   reason, that [0024](./0024-agent-libraries-loading.md) recorded for `harness/libraries.ts`.
   Nothing is written into it: the configuration the app actually wants loaded already arrives on
   the command line as `--mcp-config` and `--plugin-dir` (libraries) and `--settings` (the
   checkpoint hook, [0026](./0026-checkpoints-through-harness-hooks.md)). A second copy in `$HOME`
   would be a second source of truth for the same thing.

3. **Shaped in `resolveHarnessRunEnv`** (`packages/core/src/billing.ts`), which is already the one
   place a harness environment is assembled. A new `configEnv` parameter is applied **after**
   `profileEnv` and alongside the credential shaping, so an Executor Profile cannot be a route back
   to the operator's configuration — the same ordering argument that makes a profile unable to
   divert billing. The names it carries are dropped from `profileEnv` in passing. The variables are
   `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` and
   `CLAUDE_CONFIG_DIR`, exported from `packages/contracts/src/executor-config.ts` as
   `HARNESS_CONFIG_ENV_VARS`. `CLAUDE_CONFIG_DIR` is named explicitly because Claude Code honours
   it *over* `$HOME` — verified against 2.1.280, where a run with it set writes `.claude.json`
   inside it and not in `$HOME` — so pointing `HOME` alone would have left that door open.

4. **`HARNESS_CONFIG_ENV_VARS` is a separate constant from `GUARDED_ENV_VARS`, and stays separate.**
   `GUARDED_ENV_VARS` feeds a Zod `.refine` that *rejects* the whole Executor Profile. Adding these
   names there would start refusing every profile that has ever set `HOME` — a breaking API change,
   to prevent something that is merely futile rather than dangerous. A profile may say `HOME`; the
   run-time guard silently drops it.

5. **The executor answers for its own machine.** For the Docker driver nothing is imposed from the
   host: `resolveHarnessConfigEnv` takes the container's own `HOME` out of `baseEnv()` — already
   `CONTAINER_HOME`, already a tmpfs — and restates the other five names relative to it, so the
   same six variables are explicit on both drivers rather than one relying on defaults. **No third
   tmpfs and no new bind**; `INTENDED_TMPFS` is still exactly `["/run/solow", CONTAINER_HOME]`. A
   host path pushed into a container would name a directory that does not exist inside it.

6. **A second belt in argv for Claude Code:** `--setting-sources project,local`. The flag exists
   and takes exactly those source names (verified against 2.1.280). It omits `user`, which is the
   operator's machine-level settings, and keeps the checkout's own — and it still holds if a future
   CLI grows another route to the user's settings that `$HOME` does not cover.

7. **The two out-of-band routes get the same treatment.** `handleExplainPost` and
   `handleProbePost` (`apps/orchestrator/src/index.ts`) launch the very same harness with the very
   same credential; a probe that passed only because the operator's own `~/.claude` happened to be
   logged in would be answering for a Task that will not be. They get a home inside the scratch
   directory they already make and already remove.

**Creating the directory is a courtesy; the environment is the guarantee.** A `mkdir` that fails
does not fail the run: the harness creates its own config directory on any machine it has not run
on before, and the property that matters — that the directory is not the operator's — holds whether
or not it exists yet. A root that is genuinely unwritable is not swallowed either, because the
Task's worktree lives in the same root and `git worktree add` fails first, loudly, about the thing
an operator can act on.

## Consequences

- A Task's harness starts logged out of everything the operator's account was logged into.
  Credentials that used to come from `~/.claude` now have to come from the Harness Profile's
  Secret, which is what F06 always said. This is the intended behaviour change and the one most
  likely to surprise.
- Caches are per-Task and start cold (`XDG_CACHE_HOME` lands beside the worktree). A first tool
  call that would have hit `~/.cache` now downloads. The cost is real and was accepted: a shared
  cache is also a shared configuration surface.
- The directory joins the transcripts and the checkpoint store in the retention sweep, so a
  deleted Task no longer leaves whatever its harness cached on the machine.
- **`agent_catalog.args_template` is still appended after the app's own flags**
  (`task-run.ts`, `packages/claude-code/src/session.ts`). An operator who edits that template can
  append their own `--settings <file>` — or their own `--setting-sources user` — and it wins,
  because the operator's argv is deliberately last. This is **not closed**. Closing it means either
  refusing to be last (which breaks the template's stated purpose of overriding SoloW's defaults)
  or filtering the template for known flags (a denylist that the next CLI release outdates). It is
  recorded rather than papered over; the template is Owner-editable configuration, so this is a
  narrower hole than an unrelated file in a home directory, but it is a hole.
- **The harness's own `bash` can read its environment** and can read, or write, anything on the
  filesystem the executor gives it — the operator's real `$HOME` included, on the local driver.
  Nothing here is a sandbox. What this decision buys is that the harness is no longer *pointed* at
  that configuration by default; a model that goes looking for it can still find it. The Docker
  executor is the answer for a Task that must not be able to, and that is why it exists.
- `HOME` in an Executor Profile's `env` is now silently ignored rather than honoured. Accepted at
  the boundary (so no stored profile becomes invalid), dropped at launch.
- A remote driver (#97 SSH, #107 Kubernetes) has to answer this question for itself: a path
  computed on the orchestrator's filesystem means nothing on another machine. `needsAppOwnedHome`
  returns true for anything it cannot prove hermetic, and `executor/drivers.ts` refuses those kinds
  outright today, so the gap is visible rather than inherited.

## Alternatives considered

- **Replace the environment entirely, keeping an allowlist.** Closes more, breaks more: the
  contract suite requires a usable `PATH`, F07's Executor Profiles exist to *add* environment, and
  every proxy-behind-a-corporate-network deployment would have failed. The variable that leaks
  configuration is a short, known list; the variables that make a process work are not.
- **Add `HOME` to `GUARDED_ENV_VARS`.** One constant instead of two, at the price of a breaking API
  change that rejects profiles which have always been legal. Rejected — see Decision 4.
- **A bind-mounted app-owned home for the container too.** Symmetrical, and strictly worse: the
  container's `HOME` is already a tmpfs that dies with it, so a bind would move credential caches
  *back* onto the host filesystem — exactly what [0023](./0023-docker-executor-cli.md) removed.
- **`--bare`.** Claude Code's own flag for this shape of problem, and it does more than asked:
  it also skips plugin sync, LSP, auto-memory and CLAUDE.md auto-discovery, and restricts auth to
  `ANTHROPIC_API_KEY`. A subscription-mode run (F06, [0005](./0005-subscription-authentication.md))
  cannot use it at all. Rejected as too blunt for the problem; the environment plus
  `--setting-sources` is the part that was actually wanted.
- **A fresh home per round rather than per Task.** Stronger isolation, but it throws away whatever
  the harness cached between rounds of the same conversation, which resume depends on.
