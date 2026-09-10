---
name: speckit-verify
description: "Evidence-based verification after implementation: a verify-report.md citing, per criterion, the command that was run and what it showed."
---

# Spec Kit — verify

Ticking a task proves nothing. This Step produces `verify-report.md` beside the spec: for every
success criterion and every acceptance scenario, **evidence** that the feature builds, runs and
behaves as specified.

## Rules
- Every verdict cites a command you actually ran and its relevant output, a test that actually
  passed, or a file that actually exists — quoted, not described. "Looks fine" is not evidence.
- Three verdicts only: **PASS** (evidence shows it), **FAIL** (evidence shows it does not), and
  **UNVERIFIED** (needs a person, a device, an external system — say what).
- Run the real things: the build, the full test suite, the linter, the type checker, and the
  `quickstart.md` walkthrough. A criterion no test covers gets a check you devise now — a script,
  a curl, a query — and the script goes in the report.
- **Modify no file except the report.** A failure is reported, not fixed, so the next Step
  knows exactly what to do.

## Report structure
1. **Build & static checks** — each command, exit status, the lines that matter.
2. **Criteria** — one row per `SC-` and per acceptance scenario: verdict, evidence, notes.
3. **Task audit** — tasks marked done whose file or behaviour you could not find.
4. **Verdict** — PASS only when nothing is FAIL; list every UNVERIFIED item for a person.

## Decision
End with the answer the pipeline asks for: whether any criterion or scenario **failed**.
