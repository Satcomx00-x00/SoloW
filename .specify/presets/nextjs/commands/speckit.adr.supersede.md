---
description: Mark an existing ADR as superseded and scaffold its replacement. Preserves the audit trail — the old ADR keeps its content, gains a `superseded_by` link, and the index updates its status. The new ADR carries a back-reference and inherits the old ADR's constitution_refs unless overridden.
handoffs:
  - label: Refresh context pack
    agent: speckit.context.refresh
    prompt: Re-render `.specify/memory/context-pack.md` so the supersession is visible to the next AI session.
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| First positional arg | Prior ADR ID (e.g. `0023` or `ADR-0023`) | required |
| Second positional arg | New decision title (free-form) | required |
| `--status <s>` | Status of the new ADR | `proposed` |
| `--owner <handle>` | Owner of the new decision | git config `user.name` |
| `--keep-refs` | Carry over `constitution_refs` from the prior ADR | on by default |
| `--no-keep-refs` | Start with empty `constitution_refs` | off |

If either positional arg is missing, ask for it.

## Pre-Execution Checks

Check for `.specify/extensions.yml`. Look for hooks under `hooks.before_adr`. Apply standard hook-processing.

Verify the prior ADR file exists at `docs/adr/<NNNN>-*.md`. If not, abort with: `ADR <id> not found.`

## Outline

### 1. Read the prior ADR

Load its front-matter and "More Information" section. Capture:
- Current `status`
- Existing `superseded_by` (must be `null` — abort if already superseded)
- `constitution_refs`
- `phase` and `criticality`

Refuse to supersede an ADR whose status is already `superseded`, `rejected`, or `deprecated` unless `--force` is passed.

### 2. Delegate to /speckit.adr.new

Invoke the same logic as `/speckit.adr.new` with:
- `--supersedes <prior ID>`
- `--status <status>`
- `--owner <owner>`
- `--phase` and `--criticality` copied from the prior ADR (overridable by flags)
- `constitution_refs` copied from the prior ADR if `--keep-refs` is set

### 3. Update the prior ADR

In front-matter:
```yaml
status: superseded
superseded_by: <new NNNN>
```

Append to "More Information":
```markdown
- Superseded by: [ADR-<new NNNN>](./<new-slug>.md) on <YYYY-MM-DD>
- Reason: <one-line reason, prompted if not in $ARGUMENTS>
```

### 4. Update the ADR index

In `docs/adr/README.md`, update the prior ADR's `Status` column to `superseded` and insert the new row.

### 5. Print the result

```
## ADR supersession complete

**Prior ADR**: <prior ID> — status changed to `superseded`
**New ADR**: <new ID> — `docs/adr/<NNNN>-<slug>.md`
**Constitution refs carried over**: <list or "none">

**Next steps**:
- Fill in the new ADR's Context, Decision, and Consequences sections.
- If the supersession changes a Critical directive, run /speckit.constitution.scan.
- Search the codebase for patterns implementing the prior ADR — they may now
  contradict the new one. /speckit.adr.audit will surface them.
- If status is `proposed`, do not delete code implementing the prior ADR until
  the new one is `accepted`.
```

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_adr`. Apply standard hook-processing.
