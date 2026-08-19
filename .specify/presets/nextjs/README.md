# Next.js Web Application Preset

A Spec Kit preset for building **state-of-the-art, full-stack Next.js web applications** with Spec-Driven Development.

This preset ships **behaviors, not a tech stack**. It does not pick your ORM, styling layer, auth provider, or hosting target — but it does encode what every part of a production Next.js application must do, regardless of those choices.

## What's inside

| File | Role |
|---|---|
| `templates/constitution-template.md` | The project **directive**. Replaces the core constitution template. Encodes principles, phased criticality, and the full behavior matrix across Frontend, Backend, Security, Performance, TypeScript & Code Quality, and Infrastructure & Operations. |
| `templates/agent-context.md` | The **global agent rules**. A compressed, always-on operating manual for AI coding agents working on the project. Mirror it into the agent's context file (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, etc.). |
| `commands/speckit.constitution.scan.md` | Command **`/speckit.constitution.scan`**. Sibling to `/speckit.constitution`: scans the repository (Markdown docs, `package.json`, `tsconfig.json`, Next.js structure, tooling, CI) and exports `.specify/memory/constitution.md` with a Sync Impact Report mapping evidence to every Critical directive. |
| `commands/speckit.audit.md` | Command **`/speckit.audit`**. Audits the codebase against the TypeScript and Next.js behavioral directives. Runs the audit script, persists the JSON to `.specify/audits/`, and produces a prioritized human-readable report grouped by severity and section. |
| `commands/speckit.audit.deep.md` | Command **`/speckit.audit.deep`**. Same scope as `/speckit.audit`, then layers `tsc --noEmit`, `eslint`, `npm audit`, file-level read-throughs, and cross-file LLM analysis. Inspects every `"use server"` file for the parse → authorize → ownership → DTO recipe. Persists to `.specify/audits/deep/`. |
| `commands/speckit.plan.md` | Command **`/speckit.plan`**. Next.js-specialized feature planning. Decomposes a feature into routes, RSC/client boundaries, Server Actions, Route Handlers, DAL methods, schema validators, caching strategy, prerendering strategy, metadata, accessibility checkpoints, error handling, security checklist, and a testing plan — all tagged with Phase and Criticality. |
| `commands/speckit.tasks.md` | Command **`/speckit.tasks`**. Next.js-shaped task generation from a plan. Produces dependency-ordered tasks: schema first, then DAL, then Server Actions, then route scaffold, then RSC components, client islands, Route Handlers, metadata, skeletons, and tests. Each task has Next.js-idiomatic titles, acceptance criteria, and constitution directive references. |
| `commands/speckit.scaffold.route.md` | Command **`/speckit.scaffold.route`**. Scaffolds a Next.js App Router route segment: `page.tsx` (RSC + `generateMetadata`), `layout.tsx`, `loading.tsx` (accessible skeleton), `error.tsx` (`"use client"` boundary), `not-found.tsx`. Supports `--auth`, `--no-layout`, `--title`, and other flags. |
| `commands/speckit.scaffold.dal.md` | Command **`/speckit.scaffold.dal`**. Scaffolds a DAL module at `lib/dal/<entity>.ts` with `import 'server-only'`, typed `Result<T>` envelope, schema-validated inputs, CRUD method stubs, and a DTO mapper. Supports `--db` (prisma / drizzle / kysely / pg), `--methods`, `--schema`, and `--no-result-envelope`. |
| `commands/speckit.docs.sync.md` | Command **`/speckit.docs.sync`**. Syncs `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `GEMINI.md` from the installed `agent-context.md` template. Shows a diff (with conflict detection for custom additions) before writing. Supports `--dry-run`, `--force`, and `--targets`. |
| `commands/speckit.adr.new.md` | Command **`/speckit.adr.new`**. Scaffolds a new Architecture Decision Record at `docs/adr/NNNN-<slug>.md` in MADR 4 (full) format. Auto-numbers, links the current commit, supports `--supersedes`, `--phase`, `--criticality`, and updates the ADR index at `docs/adr/README.md`. |
| `commands/speckit.adr.supersede.md` | Command **`/speckit.adr.supersede`**. Marks an existing ADR as superseded and scaffolds its replacement. Preserves the audit trail (old ADR keeps content, gains `superseded_by` link) and carries `constitution_refs` over by default. |
| `commands/speckit.adr.audit.md` | Command **`/speckit.adr.audit`**. Audits the codebase against accepted ADRs using the optional `audit:` front-matter block (rules: `forbid`, `require`, `prefer`). Honors the central waiver registry at `.specify/waivers.yml`, phase-gates findings, and surfaces ADRs without an `audit:` block as aspirational. |
| `commands/speckit.context.refresh.md` | Command **`/speckit.context.refresh`**. Regenerates `.specify/memory/context-pack.md` — the one-page snapshot every new AI session reads first. Aggregates ADR index, open RFCs, in-flight plans, recent CHANGELOG entries, active/expired waivers, and recent session logs. Markdown-only. |
| `commands/speckit.session.close.md` | Command **`/speckit.session.close`**. Writes a structured session log at `.specify/sessions/<date>-<slug>.md` capturing decisions, files touched, CHANGELOG additions, waivers added, and follow-ups queued for the next session. Auto-detects activity via git diff against the previous session's commit. |
| `commands/speckit.handoff.md` | Command **`/speckit.handoff`**. Generates a curated, human-written handoff at `.specify/handoffs/<date>-<slug>.md` complementing the auto-generated context pack with "first 15 minutes", known traps, parked work, and a don't-touch list. Distinct from the context pack: this one is opinionated, that one is comprehensive. |
| `commands/speckit.help.md` | Command **`/speckit.help`**. Lists every spec-kit command grouped by phase of use (bootstrap / planning / implementation / quality / session) with one-line descriptions. Reads from `preset.yml`; supports `--phase`, `--detail long`, `--installed-only`. Prints a state-aware "suggested next" line. |
| `scripts/bash/scan-repo.sh` · `scripts/powershell/scan-repo.ps1` | Repository scanners (inventory). Emit JSON per `scripts/SCHEMA.md` — `.md` inventory, parsed `package.json` and `tsconfig.json`, Next.js structure, `"use client"` / `"use server"` counts, DAL detection, CI workflows, env files, Node version pin, git metadata. |
| `scripts/bash/audit-codebase.sh` · `scripts/powershell/audit-codebase.ps1` | Rule-based audit engine. 23 high-signal rules across TypeScript (compiler flags + type-system discipline), Frontend (RSC discipline, images, links, metadata), Backend (DAL `server-only`, env handling), Security (sessions, secrets, SQL, XSS), Performance, Infrastructure. Each finding carries `rule_id`, `severity`, `section`, `phase`, `scope`, `directive`, `remediation`, `file:line`, and a snippet. Designed for big codebases: single file enumeration, parallel grep via `xargs -P`, `--paths` / `--rules` / `--sections` filters, `--max-findings-per-rule` cap, `--list-rules` introspection. |
| `scripts/SCHEMA.md` | Stable contract between scripts and commands (`schema_version: "1.0"`). |

## Operating framework

Every directive is tagged with a **Phase** and a **Criticality**:

- **Phase** — when it must hold: `P1 Foundation` → `P2 MVP` → `P3 Hardening` → `P4 Scale` (continuous).
- **Criticality** — how strictly: `Critical` (blocks release) · `High` (needs an approved, time-bound exception) · `Medium` (default) · `Low` (recommended).

The framework lets a team start enforcing the right things at the right time — without pretending a green-field MVP needs the same controls as a production app with paying customers, and without letting a production app drift on principles that should have been settled before the first commit.

## Coverage

- **Core principles** — Server-first architecture · Type-safety without escape hatches · Defense-in-depth security · Validated boundaries · Performance measured, not guessed · Accessibility non-negotiable · Observability and auditability · Quality code by default.
- **Frontend behaviors** — Server Components, streaming, Suspense layering, route conventions, accessibility, image and font discipline, client-state minimization.
- **Backend behaviors** — Data Access Layer, thin actions, schema-validated boundaries, authorization at the action, ownership checks, DTOs, transactions, webhooks, idempotency.
- **Security behaviors** — Layered enforcement, session hygiene, secrets handling, CSP and security headers, MFA, audit trail, dependency posture.
- **Performance behaviors** — Explicit caching, parallel fetches, field-data-driven optimization, CWV budgets in CI, image/font/script discipline, bundle audits, INP protection.
- **TypeScript Engineering behaviors** (carries a third tag — **Scope**: `FE` / `BE` / `Both`) — organized into eight subsections: Compiler & Project Config, Type System Discipline, SOLID, Clean Code & Functional Discipline, Runtime Boundaries, Frontend Patterns, Backend Patterns, Project Hygiene & DX. Covers strict compiler flags, banned escape hatches, `satisfies` vs `as`, branded/nominal IDs, discriminated unions, parse-don't-validate boundaries, schema-derived types, dependency injection, exhaustive switches with `never`, and naming/linting/test discipline.
- **Infrastructure & Operations behaviors** — Reproducible builds, secret management, environment parity, immutable deploys, health-gated rollouts, backups with drills, observability, SLOs, blameless retrospectives.

## Install (local development)

```bash
specify preset add --dev ./presets/nextjs
```

Verify the constitution template resolves to this preset:

```bash
specify preset resolve constitution-template
```

Then run **one** of the constitution commands in your project:

```bash
# Interactive: drafts the constitution from a prompt + repo context
/speckit.constitution

# Scan-driven: scans the repo (Markdown + package.json + tsconfig + Next.js
# structure + tooling + CI) and exports a properly-structured constitution
# with a Sync Impact Report mapping evidence to every Critical directive.
/speckit.constitution.scan
```

Both produce `.specify/memory/constitution.md` — the project's living directive.

### What `/speckit.constitution.scan` does

1. Runs `scripts/bash/scan-repo.sh` (or `scan-repo.ps1`) to build a JSON inventory of the repository.
2. Reads the most relevant Markdown evidence (`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`, agent context files, plus up to 10 likely product/engineering docs).
3. Decides the operating **phase** (P1–P4) from evidence — defaults to P1 if no production signal is present.
4. Fills the Next.js constitution template (does **not** rewrite the behavior matrix — the matrix is the source of truth).
5. Prepends a **Sync Impact Report** as an HTML comment: inventory snapshot, per-directive status (`MET` / `NOT MET` / `PARTIAL` / `UNVERIFIED`), Markdown evidence consulted, and follow-up TODOs.
6. Flags downstream templates (`plan-template`, `spec-template`, `tasks-template`, command files, agent context files) that may need realignment — **without** silently editing them.
7. Writes `.specify/memory/constitution.md` and prints a summary plus a suggested commit message.

You can pass freeform context with the command, e.g.:

```bash
/speckit.constitution.scan ratification date 2026-05-18; treat auth as Critical from P1
```

## Command reference

### Setup

| Command | What it does |
|---|---|
| `/speckit.constitution` | Interactive constitution draft (core spec-kit) |
| `/speckit.constitution.scan` | Scan-driven: inventories the repo and exports a constitution with a Sync Impact Report |
| `/speckit.docs.sync` | Sync agent context files from the installed `agent-context.md` template |

### Development workflow

| Command | What it does |
|---|---|
| `/speckit.plan <description>` | Decompose a feature into routes, actions, DAL methods, schemas, caching, metadata, and accessibility checkpoints |
| `/speckit.tasks [plan-path]` | Generate dependency-ordered implementation tasks from a plan |
| `/speckit.scaffold.route <path>` | Scaffold `page.tsx` + `layout.tsx` + `loading.tsx` + `error.tsx` + `not-found.tsx` for a route segment |
| `/speckit.scaffold.dal <entity>` | Scaffold `lib/dal/<entity>.ts` with `server-only`, `Result<T>` envelope, and CRUD stubs |

### Quality

| Command | What it does |
|---|---|
| `/speckit.audit` | Regex-based audit against 23 rules — TypeScript, Frontend, Backend, Security, Performance, Infrastructure |
| `/speckit.audit.deep` | Full audit: regex + `tsc --noEmit` + `eslint` + `npm audit` + LLM file-level confirmation + Server Action recipe check |
| `/speckit.adr.audit` | Audit the codebase against accepted ADRs (forbid/require/prefer rules from each ADR's `audit:` block); honors `.specify/waivers.yml` |

### Decision memory

The memory layer is what keeps multi-session AI development consistent. ADRs
capture the *why*, the context pack lets each new session bootstrap into
current state, and session logs leave breadcrumbs from one iteration to the
next.

| Command | What it does |
|---|---|
| `/speckit.adr.new <title>` | Scaffold a new MADR 4 (full) ADR at `docs/adr/NNNN-<slug>.md`; updates the ADR index |
| `/speckit.adr.supersede <id> <new-title>` | Mark an ADR as superseded and scaffold its replacement, preserving the audit trail |
| `/speckit.context.refresh` | Regenerate `.specify/memory/context-pack.md` — ADRs + RFCs + in-flight plans + CHANGELOG + waivers + recent sessions |
| `/speckit.session.close <title>` | Write `.specify/sessions/<date>-<slug>.md` capturing decisions, files touched, follow-ups queued |
| `/speckit.handoff [slug]` | Write a curated `.specify/handoffs/<date>-<slug>.md` with "first 15 minutes", known traps, parked work, don't-touch list |

### Meta

| Command | What it does |
|---|---|
| `/speckit.help [--phase <p>] [--detail long]` | List every command grouped by phase of use; prints a state-aware "suggested next" line |

### Typical workflow

```
1. /speckit.constitution.scan        # generate the project constitution
2. /speckit.docs.sync                # wire agent context files
3. /speckit.context.refresh          # build the first context pack

# for each feature:
4. /speckit.plan <feature>           # decompose the feature
5. /speckit.tasks                    # generate implementation tasks
6. /speckit.scaffold.route app/<path>  # scaffold route files
7. /speckit.scaffold.dal <entity>    # scaffold DAL module
8. ... implement ...
9. /speckit.adr.new <decision>       # record architectural decisions as they're made
10. /speckit.audit                   # pre-PR quality gate (constitution rules)
11. /speckit.adr.audit               # pre-PR quality gate (decision-specific rules)
12. /speckit.audit.deep              # pre-release quality gate

# at the end of each AI session:
13. /speckit.session.close <title>   # write the session log + follow-ups
14. /speckit.context.refresh         # refresh the snapshot for the next session
```

## Wiring the agent context

After installation, mirror `templates/agent-context.md` into your agent's context file so the rules apply on every turn:

- **Claude Code** → `CLAUDE.md`
- **GitHub Copilot** → `.github/copilot-instructions.md`
- **Gemini CLI** → `GEMINI.md`
- **Codex / generic** → `AGENTS.md`

Either copy the contents directly or reference the file from your agent context:

```markdown
<!-- in AGENTS.md / CLAUDE.md / .github/copilot-instructions.md -->
The operating rules for this project live in
`.specify/presets/nextjs/templates/agent-context.md`. Read them before
proposing changes; the constitution at `.specify/memory/constitution.md`
is authoritative on conflict.
```

## Governance

The constitution **supersedes ad-hoc conventions**. When a directive here conflicts with a tutorial, a blog post, a framework changelog, or an LLM suggestion, the constitution wins until it is formally amended via PR with a changelog entry — and, where criticality or phase changes, a migration plan for affected code.

Waivers for Critical or High directives must be recorded inline with an owner, a reason, and an expiry no further than one release cadence away.
