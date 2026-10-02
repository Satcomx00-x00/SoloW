# 0028 — Harness configuration is stored in the app and handed over at launch

**Status:** Accepted · **Date:** 2026-10-02 · **Deciders:** Architecture
**Builds on:** [0027](./0027-hermetic-harness-configuration.md), [0024](./0024-agent-libraries-loading.md),
[0026](./0026-checkpoints-through-harness-hooks.md) ·
**Enables:** [F05](../features/F05-harness-executor-profiles.md)

## Context

[0027](./0027-hermetic-harness-configuration.md) stopped a Task's harness from reading the
operator's `~/.claude/settings.json` or `~/.config/opencode/opencode.json`: every run starts from a
blank, app-owned home. That left no way to give a harness *any* configuration of its own beyond
what SoloW itself generates (libraries, checkpoint hooks). An operator who wants a permission
allowlist, a status line, an opencode theme or provider routing had two options, both bad: edit
their own machine's config — which no run reads any more — or hand-write flags into the catalog's
`argsTemplate`, which 0027 records as an unclosed hole.

What was wanted: configs a user owns in the app, can edit from the UI, duplicate, share, and select
per Harness Profile — and the app must never use, let alone modify, the host's own config files.

## Decision

1. **A `harness_config` table**, Workspace-scoped (Principle V): `name` (unique per Workspace),
   `description`, `harness` (`claude_code` | `opencode`) and `content` — the harness's own JSON
   object, stored verbatim. SoloW does not model the harness's schema; the editor starts from the
   harness's published `$schema`.

2. **A Harness Profile selects at most one** (`agent_profile.harness_config_id`, nullable). Null —
   every existing row — launches exactly as before. The DAL refuses a config written for a different
   harness than the Profile's catalog row (`configHarnessFor`: Claude Code by the stream-json
   protocol; opencode by key or launched binary). Like the permission mode, it is editable and
   applies to the next launch.

3. **Delivery by flag or variable, never by a file in a home.** Claude Code receives the config as
   its inline `--settings` (flag settings outrank every settings file and are read whatever
   `--setting-sources` says); opencode receives it as `OPENCODE_CONFIG_CONTENT`, its
   highest-precedence inline source. Both reach a container exactly as they reach a local process, so
   one mechanism holds on every Executor driver, and the app-owned home of 0027 stays seeded empty.

4. **The app's own settings still win.** A Step's checkpoint hook is deep-merged *over* the
   config (`mergeHarnessSettings`: objects recurse, arrays concatenate, the app's scalars win), so a
   config can add hooks of its own but can never displace the checkpoint. The variable rides in
   `configEnv`, applied above an Executor Profile's `env` and below the credential shaping.

5. **A config cannot carry a credential or point back at the host.** `harnessConfigViolations`
   refuses Claude Code `env` entries naming the billing variables, the configuration-discovery
   variables of 0027 or the delivery variable itself, plus `apiKeyHelper`; and opencode
   `provider.*.options.apiKey`. Checked at the API boundary with every offending key named, and
   again at launch against the running catalog row's own two credential variables — a refusal there
   fails the round with a notice naming the config, rather than starting a run on a guess.

6. **Read at launch, inside the step that spawns the harness**, like the libraries, so an edit is
   the next round's configuration. The run log says which config was used. The probe and explain
   routes apply the same config, so a probe cannot pass on a configuration a run would refuse.

7. **Sharing is a document, not a link.** `profile.harnessConfig.export` returns
   `{ kind: "solow.harness-config", version: 1, name, description, harness, content }` — no ids, no
   Workspace — and `import` reads it back, suffixing "(copy)" to a taken name, as `duplicate` does.
   Writes are withheld from the external MCP surface for the reason the libraries are.

## Consequences

- The operator's own harness configuration is never read and never written by SoloW. Everything a
  run's harness is configured with is in the database and visible in Settings.
- A config is stored in plain text. That is why credentials are refused outright rather than
  merely discouraged: the Profile's Secret is the only place one belongs (F06).
- A harness SoloW has no delivery for (a custom ACP agent that is not opencode) cannot select a
  config; the picker says "Not configurable" rather than offering one that would be ignored.
- Inline delivery bounds a config at 64 KB of JSON, comfortably under `ARG_MAX` and any
  environment limit.
- The `argsTemplate` hole recorded in 0027 is unchanged: a template that appends its own
  `--settings` still wins, because the operator's argv is deliberately last.

## Alternatives considered

- **Write the file into the app-owned home.** Works for the local driver only: the container's
  home is a tmpfs the host cannot write to (0023, 0027), so the two drivers would disagree again —
  the exact problem 0027 removed.
- **One config per catalog row instead of per Profile.** Two Profiles of one harness routinely want
  different settings (a strict reviewer, a permissive implementer); a catalog row is the harness,
  not how it is used.
- **Model each harness's settings schema in SoloW.** A typed form would rot with every CLI release.
  JSON plus the harness's own `$schema` is the contract the harness itself publishes.
