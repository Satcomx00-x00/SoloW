---
description: List every spec-kit command grouped by phase of use, with one-line descriptions. Read this when you've forgotten which command to run next, or to onboard a new contributor (human or AI).
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| `--phase <p>` | Show only commands for the given phase (`bootstrap` / `planning` / `implementation` / `quality` / `session`) | all |
| `--format <fmt>` | `human` / `markdown` / `json` | `human` |
| `--detail <level>` | `short` (description only) / `long` (description + flags + handoff chain) | `short` |
| `--installed-only` | Show only commands whose files are present under `.specify/` (omit any registered in `preset.yml` but not installed) | off |

## Pre-Execution Checks

None — `/speckit.help` is a pure read of the preset registry. It must work even when `.specify/` is missing or partially installed.

## Outline

### 1. Locate the preset registry

In order:
1. `.specify/preset.yml` (installed)
2. `presets/nextjs/preset.yml` (in-repo, when run from the spec-kit source tree)
3. Built-in fallback list (the table in step 3)

If none of the above are readable, fall back to the static table in step 3 and label the output `(fallback — preset.yml not found)`.

### 2. Resolve installed status (only if `--installed-only`)

For each command entry, check whether the referenced `file:` path exists relative to `.specify/`. Drop entries whose file is missing.

### 3. Render the grouped command list

Group commands into five phases. The grouping is fixed regardless of preset additions — new commands map to a phase via the `phase:` field in their front-matter, defaulting to `implementation` if absent.

```
# spec-kit command reference

Read top to bottom — the phases mirror the order you'll actually run them.

## Phase 0 — Project bootstrap (run once per project)

  /speckit.constitution
      Interactive constitution draft — pick directives by hand. Best for
      greenfield projects with strong opinions.

  /speckit.constitution.scan
      Scan-driven constitution — inventories the repo, emits directives
      tagged by Phase / Criticality, includes a Sync Impact Report. Best
      for existing projects.

  /speckit.docs.sync
      Wire AGENTS.md / CLAUDE.md / .github/copilot-instructions.md / GEMINI.md
      from the agent-context template. Run after constitution changes.

  /speckit.context.refresh
      Build .specify/memory/context-pack.md — the one-page snapshot every
      new AI session reads first. Re-run after any phase-0 change.

## Phase 1 — Feature planning (per feature)

  /speckit.plan <description>
      Decompose a feature into routes, RSC/client boundaries, Server Actions,
      Route Handlers, DAL methods, schemas, caching, metadata, and a11y.

  /speckit.tasks [plan-path]
      Generate dependency-ordered implementation tasks from a plan.

## Phase 2 — Implementation (per feature)

  /speckit.scaffold.route <path>
      Scaffold page.tsx + layout.tsx + loading.tsx + error.tsx + not-found.tsx
      for an App Router segment.

  /speckit.scaffold.dal <entity>
      Scaffold lib/dal/<entity>.ts with `server-only`, Result<T> envelope,
      and CRUD stubs.

  /speckit.adr.new <title>
      Capture an architectural decision as you make it. MADR 4 (full) format,
      auto-numbered, links the current commit, updates docs/adr/README.md.

  /speckit.adr.supersede <id> <new-title>
      Replace an outdated ADR. Preserves the audit trail and carries
      constitution_refs forward.

## Phase 3 — Quality gates (pre-PR / pre-release)

  /speckit.audit
      Regex audit against the constitution's 23 rules — TypeScript, Frontend,
      Backend, Security, Performance, Infrastructure. Fast; run on every PR.

  /speckit.adr.audit
      Code-vs-ADR audit using each ADR's optional `audit:` block (forbid /
      require / prefer). Honors .specify/waivers.yml. Phase-gated severity.

  /speckit.audit.deep
      Full audit: regex + tsc --noEmit + eslint + npm audit + LLM file-level
      confirmation + Server Action recipe check. Slow; run pre-release.

## Phase 4 — Session boundaries (end of each AI iteration)

  /speckit.session.close <title>
      Write .specify/sessions/<date>-<slug>.md — decisions taken, files
      touched, CHANGELOG additions, waivers added, follow-ups queued.

  /speckit.context.refresh
      Refresh the snapshot for the next session. Run after /speckit.session.close.

  /speckit.handoff [slug]
      Curated, hand-written handoff at .specify/handoffs/. Distinct from the
      auto-generated context pack: "first 15 minutes", known traps, parked
      work, don't-touch list.

## Meta

  /speckit.help [--phase <p>] [--detail long]
      This listing.
```

### 4. If `--detail long`, expand each command

For each line, append:
- `Flags:` — pulled from the command file's `User Input` parse table
- `Handoffs:` — pulled from the command's front-matter `handoffs:` block
- `Reads:` — files the command consumes
- `Writes:` — files the command produces

Skip any field that's empty.

### 5. If `--phase` is set, filter

Show only the matching phase block. Other phases are listed by name with a count, so the reader knows what they're skipping.

### 6. Suggested next command

After the listing, print one line tailored to project state:

| Detected state | Suggestion |
|---|---|
| No `.specify/memory/constitution.md` | `Suggested next: /speckit.constitution.scan` |
| Constitution exists, no `AGENTS.md` | `Suggested next: /speckit.docs.sync` |
| `docs/adr/` empty, has plans | `Suggested next: /speckit.adr.new "..."` to capture in-flight decisions |
| `.specify/sessions/` mtime > 24h ago, working tree has changes | `Suggested next: /speckit.session.close "<short title>"` |
| `.specify/memory/context-pack.md` older than newest ADR | `Suggested next: /speckit.context.refresh` |
| Otherwise | `Suggested next: /speckit.audit` (the cheapest signal before any commit) |

This is best-effort; skip silently if state can't be read.

## Post-Execution Hooks

None. `/speckit.help` is side-effect free.
