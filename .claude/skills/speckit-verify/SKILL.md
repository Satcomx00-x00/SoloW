---
name: "speckit-verify"
description: "Post-implementation verification. Produces verify-report.md with per-acceptance-criterion EVIDENCE that the feature actually builds, runs, and behaves as specified — the closing loop after implement."
compatibility: "Requires spec-kit project structure with .specify/ directory"
metadata:
  author: "github-spec-kit"
  source: "templates/commands/verify.md"
user-invocable: true
disable-model-invocation: false
---


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

`/speckit-implement` marks tasks done; nothing in the core cycle proves the
result works. This command closes that loop. It is **evidence-based**: every
verdict cites a command you actually ran and its output, a file that actually
exists, or a response you actually observed. A criterion you could not
exercise is reported `UNVERIFIABLE` with the reason — never silently passed.

Hard rules:

- **Never mark a criterion PASS from reading the code alone.** Code that looks
  correct is a `PLAUSIBLE` note, not evidence.
- **Checked boxes are claims, not proof.** Re-derive every verdict; ignore the
  `[x]` state in tasks.md and checklists.
- Report failures plainly. A verify run that finds nothing wrong on the first
  pass of a non-trivial feature is suspicious — say so if it happens.

## Outline

1. **Initialize**: Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root and parse FEATURE_DIR. Load
   `spec.md` (acceptance criteria, success metrics, rollback thresholds, flag
   name), `plan.md` (observability plan §10, testing plan §11, flag registry
   location §6), `tasks.md` (claimed-done tasks). Abort with guidance if spec
   or tasks are missing.

2. **Build & boot**:
   - Run the project's install/build/typecheck commands (from the constitution
     or package.json scripts). Record exit codes.
   - Start the app (dev server or built output). Record that it boots and
     serves a 200 on the root or a known route. If the app cannot be started
     in this environment, record `UNVERIFIABLE: <reason>`.

3. **Acceptance criteria** — for each AC in the spec (EARS-format):
   - Derive a concrete probe: an HTTP request, a CLI/test invocation, a
     browser action (if a browser tool is available), or a targeted test run.
   - Execute it. Record: probe used, observed result, verdict
     `PASS | FAIL | UNVERIFIABLE`.
   - For `IF <failure case>` criteria, actually trigger the failure case
     (invalid input, missing auth, wrong tenant) — do not assume the guard
     works because it exists.

4. **Feature flag**: Grep the project's flag registry for the exact flag key
   in the spec header. Verify: key registered, default OFF, and at least one
   guard site referencing it in code. FAIL if the spec declares a flag that
   does not exist in the registry — this is a common real-world failure mode.

5. **Migrations**: If the plan declares schema changes, verify a generated
   migration file exists and applies cleanly to a local/ephemeral database.

6. **Tests & gates**:
   - Run the test files named in plan §11. Record pass/fail per file, and
     verify the `@critical` isolation spec exists and passes (or
     `UNVERIFIABLE` with reason).
   - For every quality gate the constitution or tasks.md claims (lint,
     typecheck, coverage, dead-code, secret scan): verify the gate **exists in
     the repository's CI configuration** before trusting it. Report
     `GATE_MISSING_FROM_CI` for any claimed gate absent from CI files.

7. **Observability**: For each row of plan §10, verify the signal is actually
   emitted: grep for the span/log/event instrumentation at the implemented
   call sites, and where the stack allows, exercise a request and confirm
   output (log line, span export, event row). Planned-but-absent
   instrumentation is FAIL, not a note.

8. **Service Interaction Map**: Cross-check the plan's Service Interaction
   Map against the implementation diff, in both directions:
   - Every "yes" row has actual call sites in the code (a declared cache
     write, worker enqueue, or external API call that was never implemented
     is FAIL — the plan promised it);
   - Every service the diff touches (imports of the DB/cache/queue/workflow
     clients, external API SDKs, storage, realtime channels) appears as a
     "yes" row — an undeclared interaction is `MAP_DRIFT` and FAIL, not a
     note;
   - Every external-API call site enforces the declared timeout and retry
     budget (grep the client configuration — a bare call with no timeout
     fails the row).

9. **Rollback thresholds**: Verify each threshold in the spec maps to a
   deployed/committed alert rule (file in the repo or IaC reference). Report
   `THRESHOLD_UNWIRED` for each one that is prose-only.

10. **Write `FEATURE_DIR/verify-report.md`**:

   ```markdown
   # Verify Report: [feature] — [date]

   **Overall**: PASS | FAIL (N criteria failed, M unverifiable)
   **Build & boot**: [evidence]

   | ID | Criterion | Probe | Observed | Verdict |
   |----|-----------|-------|----------|---------|

   ## Flag / Migration / Gates / Observability / Interaction map / Rollback wiring
   [one short evidenced subsection each]

   ## Unverifiable
   [each with the concrete reason and what a human must do to verify it]

   ## Follow-ups
   [every FAIL and UNVERIFIABLE as an actionable item]
   ```

11. **Verdict**: Print the overall verdict and the failing table rows. Exit
    stance: FAIL means the feature is **not ready for review** — say exactly
    that, and list the follow-ups. Do not soften it.

## Post-Execution Checks

**Check for extension hooks (after verification)**:
- Check if `.specify/extensions.yml` exists; look for `hooks.after_verify`
- Follow the same hook-execution rules as other commands (optional vs
  mandatory, no condition evaluation).
