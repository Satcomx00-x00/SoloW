---
description: Audit the codebase against accepted ADRs. For each ADR, surface code patterns that contradict the decision and code patterns the ADR mandates but cannot be found. Severity is derived from the ADR's `criticality` field. Findings respect the central waiver registry at `.specify/waivers.yml`.
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| `--adr <id>` | Audit only the listed ADR(s) — comma-separated | all `accepted` ADRs |
| `--phase <p>` | Audit only ADRs whose phase ≤ given phase | current project phase |
| `--paths <list>` | Restrict the scan to these paths | whole repo (excludes `.git`, `node_modules`, `.next`) |
| `--include-proposed` | Also audit `proposed` ADRs (advisory only) | off |
| `--format <fmt>` | `human` / `json` / `markdown` | `human` |
| `--output <path>` | Persist a copy of the report | `.specify/audits/adr/<ISO-timestamp>.<fmt>` |

## Pre-Execution Checks

Check for `.specify/extensions.yml`. Look for hooks under `hooks.before_audit`. Apply standard hook-processing.

Verify `docs/adr/` exists. If not, abort with: `No ADRs found. Run /speckit.adr.new first.`

Verify `.specify/memory/constitution.md` exists. If not, warn: `No constitution found; criticality phase-gating will fall back to the ADR's own criticality field.`

## Outline

### 1. Build the ADR index

Walk `docs/adr/*.md`. For each file, parse the front-matter. Collect:
- `id`, `title`, `status`, `phase`, `criticality`
- `constitution_refs` (used to derive specific patterns to check)
- An optional `audit:` block — if present, drives the checks (see step 2)

Skip ADRs whose `status` is not `accepted` unless `--include-proposed` is set.

### 2. Resolve audit rules per ADR

An ADR can declare its own checks in front-matter:

```yaml
audit:
  forbid:
    - pattern: "useEffect\\([^)]*\\)\\s*=>\\s*\\{[^}]*fetch\\("
      paths: ["app/**/*.tsx", "src/**/*.tsx"]
      message: "Client-side fetching forbidden — use Server Components (ADR-0042)"
  require:
    - pattern: "import\\s+['\"]server-only['\"]"
      paths: ["lib/dal/**/*.ts", "src/lib/dal/**/*.ts"]
      message: "Every DAL module must import 'server-only' (ADR-0017)"
  prefer:
    - pattern: "from\\s+['\"]drizzle-orm['\"]"
      message: "Drizzle is the chosen ORM (ADR-0042) — prefer over alternatives"
```

If `audit:` is absent, the ADR is **audit-advisory only** — surface its title and ID but do not produce code-level findings. (Prompt the user to add an `audit:` block when implementing the decision.)

### 3. Resolve waivers

Read `.specify/waivers.yml`. Each entry:

```yaml
- id: ADR-0042/forbid#1
  reason: Legacy dashboard widget — to be removed by 2026-07-01
  owner: @alice
  expires: 2026-07-01
```

A finding matches a waiver when its `<adr-id>/<rule-bucket>#<pattern-index>` equals the waiver `id`. Waivers past `expires` are reported as expired and do NOT suppress the finding.

### 4. Run the scans

For each ADR's `audit:` block:

| Rule bucket | Behavior | Severity |
|---|---|---|
| `forbid` | Matching code is a finding | derived from ADR `criticality` |
| `require` | Missing match in the listed paths is a finding | derived from ADR `criticality` |
| `prefer` | Matching alternative patterns is a finding | `Low` regardless of criticality |

Use `xargs -P` or equivalent for parallel grep, matching the scaling approach in `audit-codebase.sh`. Cap matches per pattern at `--max-findings-per-rule` (default 50).

### 5. Phase-gate the findings

For each finding, compare ADR `phase` vs. project `current_phase` (from constitution). If the ADR's phase is in the future, downgrade the finding severity by one level (`Critical` → `High`, `High` → `Medium`, etc.) and label it `(future-phase)`.

### 6. Render the report

```
## ADR Audit Report

**Project phase**: <P1-P4>
**ADRs scanned**: <count> (accepted: <n>, proposed: <n>, audit-advisory only: <n>)
**Total findings**: <n> (Critical: <n>, High: <n>, Medium: <n>, Low: <n>)
**Waivers applied**: <n> (active: <n>, expired: <n>)

### Critical

#### ADR-0017 — "DAL modules must import 'server-only'"
*Rule*: `require` / pattern #1
*Constitution refs*: BE.DAL.missing-server-only

- `lib/dal/projects.ts` — missing `import 'server-only'`
  *Remediation*: Add `import 'server-only'` as the first non-comment line.

#### ADR-0042 — "Use Drizzle for the data layer" *(future-phase: P3)*
*Rule*: `forbid` / pattern #2
*Constitution refs*: BE.DAL.orm-consistency

- `lib/dal/users.ts:14` — imports `@prisma/client`
  *Remediation*: Migrate this query to Drizzle. See ADR-0042 §Migration plan.
  *Waiver*: none

### High
... (similar structure) ...

### Audit-advisory ADRs (no `audit:` block)

These ADRs were not checked at the code level. Consider adding `audit:` rules
so they're enforced rather than aspirational.

- ADR-0033 — "Adopt OpenTelemetry for tracing"
- ADR-0051 — "All cron jobs must be idempotent"

### Expired waivers (no longer suppressing findings)

- `ADR-0042/forbid#2` expired 2026-04-12 (owner @alice). Renew or remediate.
```

If `--format json` is set, emit a machine-readable shape mirroring `scripts/SCHEMA.md`. If `--format markdown`, emit the rendered report.

### 7. Persist and exit

Write a copy to `.specify/audits/adr/<ISO-timestamp>.<fmt>`.

Exit codes:
- `0` if no Critical findings (advisory: any High count > 0 prints a warning)
- `1` if any Critical finding is present and not waived
- `2` if any Critical or High waiver has expired

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_audit`. Apply standard hook-processing.
