---
name: "speckit-specify"
description: "Create or update the feature specification from a natural language feature description."
argument-hint: "Describe the feature you want to specify"
compatibility: "Requires spec-kit project structure with .specify/ directory"
metadata:
  author: "github-spec-kit"
  source: "templates/commands/specify.md"
user-invocable: true
disable-model-invocation: false
---


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before specification)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_specify` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    Wait for the result of the hook command before proceeding to the Outline.
    ```
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently

## Outline

The text the user typed after `/speckit-specify` in the triggering message **is** the feature description. Assume you always have it available in this conversation even if `$ARGUMENTS` appears literally below. Do not ask the user to repeat it unless they provided an empty command.

Given that feature description, do this:

1. **Generate a concise short name** (2-4 words) for the feature:
   - Analyze the feature description and extract the most meaningful keywords
   - Create a 2-4 word short name that captures the essence of the feature
   - Use action-noun format when possible (e.g., "add-user-auth", "fix-payment-bug")
   - Preserve technical terms and acronyms (OAuth2, API, JWT, etc.)
   - Keep it concise but descriptive enough to understand the feature at a glance
   - Examples:
     - "I want to add user authentication" → "user-auth"
     - "Implement OAuth2 integration for the API" → "oauth2-api-integration"
     - "Create a dashboard for analytics" → "analytics-dashboard"
     - "Fix payment processing timeout bug" → "fix-payment-timeout"

2. **Branch creation** (optional, via hook):

   If a `before_specify` hook ran successfully in the Pre-Execution Checks above, it will have created/switched to a git branch and output JSON containing `BRANCH_NAME` and `FEATURE_NUM`. Note these values for reference, but the branch name does **not** dictate the spec directory name.

   If the user explicitly provided `GIT_BRANCH_NAME`, pass it through to the hook so the branch script uses the exact value as the branch name (bypassing all prefix/suffix generation).

3. **Create the spec feature directory**:

   Specs live under the default `specs/` directory unless the user explicitly provides `SPECIFY_FEATURE_DIRECTORY`.

   **Resolution order for `SPECIFY_FEATURE_DIRECTORY`**:
   1. If the user explicitly provided `SPECIFY_FEATURE_DIRECTORY` (e.g., via environment variable, argument, or configuration), use it as-is
   2. Otherwise, auto-generate it under `specs/`:
      - Check `.specify/init-options.json` for `branch_numbering`
      - If `"timestamp"`: prefix is `YYYYMMDD-HHMMSS` (current timestamp)
      - If `"sequential"` or absent: prefix is `NNN` (next available 3-digit number after scanning existing directories in `specs/`)
      - Construct the directory name: `<prefix>-<short-name>` (e.g., `003-user-auth` or `20260319-143022-user-auth`)
      - Set `SPECIFY_FEATURE_DIRECTORY` to `specs/<directory-name>`

   **Create the directory and spec file**:
   - `mkdir -p SPECIFY_FEATURE_DIRECTORY`
   - Copy `.specify/templates/spec-template.md` to `SPECIFY_FEATURE_DIRECTORY/spec.md` as the starting point
   - Set `SPEC_FILE` to `SPECIFY_FEATURE_DIRECTORY/spec.md`
   - Persist the resolved path to `.specify/feature.json`:
     ```json
     {
       "feature_directory": "<resolved feature dir>"
     }
     ```
     Write the actual resolved directory path value (for example, `specs/003-user-auth`), not the literal string `SPECIFY_FEATURE_DIRECTORY`.
     This allows downstream commands (`/speckit-plan`, `/speckit-tasks`, etc.) to locate the feature directory without relying on git branch name conventions.

   **IMPORTANT**:
   - You must only create one feature per `/speckit-specify` invocation
   - The spec directory name and the git branch name are independent — they may be the same but that is the user's choice
   - The spec directory and file are always created by this command, never by the hook

4. Load `.specify/templates/spec-template.md` to understand required sections.

5. **Intake interview** — before writing anything, interview the user so the
   spec is built on confirmed decisions instead of guesses.

   **When to skip**: skip the entire interview (and document every default
   taken in the Assumptions section) when any of these hold:
   - The user wrote "quick", "just generate", "no questions", or `--no-interview`
     in the feature description
   - The session is non-interactive (workflow/CI run with no user available) —
     never stall a pipeline waiting for interview answers
   - The feature description already answers a question — never re-ask what
     the user has already said

   **Format rules** (professional, low-friction):
   - At most **2 rounds**, at most **4 questions per round**, presented as one
     block per round — never one message per question
   - Every question offers lettered options with exactly one marked
     **(default)**; the user may reply per question (`Q1: B, Q2: default`),
     or `defaults` to accept every remaining default
   - Options must be real alternatives with different implications — no
     filler options
   - After each round, echo a one-line summary of what was decided before
     continuing

   **Round 1 — Product framing** (always, minus already-answered):

   ```markdown
   ## Intake — Round 1 of 2: Product framing

   **Q1 — Who is this for?**
   | Option | Answer | Implications |
   |--------|--------|--------------|
   | A | [role(s) inferred from description] (default) | [scope implication] |
   | B | [plausible alternative audience] | [implication] |
   | C | All authenticated users | [implication] |

   **Q2 — What single outcome makes this feature a success?**
   | A | [inferred metric, e.g. "X% of active tenants use it in 30 days"] (default) | measured via analytics |
   | B | [task-completion / latency alternative] | [implication] |

   **Q3 — What is explicitly OUT of scope for v1?**
   | A | [inferred non-goals] (default) | keeps v1 small |
   | B | Nothing — full scope in one release | larger spec, longer delivery |

   **Q4 — Which slice must ship first (P1)?**
   | A | [inferred primary story] (default) | thinnest end-to-end slice |
   | B | [alternative slice] | [implication] |

   Reply per question (`Q1: A, Q2: B, ...`) or `defaults`.
   ```

   **Round 2 — Behavior & operations** (ask only the rows that apply to this
   feature; drop rows that don't):

   ```markdown
   ## Intake — Round 2 of 2: Behavior & operations

   **Q5 — Failure behavior**: when [the main mutation] fails, what should the
   user experience be?
   | A | Inline error, data preserved, retry available (default) | standard |
   | B | [feature-specific alternative, e.g. queued + notified] | [implication] |

   **Q6 — Data & privacy**: does this feature store personal or sensitive data?
   | A | [inference from description] (default) | drives GDPR table + retention |
   | B | Yes — [fields] with [retention] | deletion/export path required |
   | C | No personal data | GDPR section minimal |

   **Q7 — Rollout**: how should this reach users?
   | A | Flag ON progressively: internal → beta → all (default) | safest |
   | B | Internal/staff only for now | validation before exposure |
   | C | Everyone at release | only for low-risk changes |

   **Q8 — Access & limits**: which plans/roles get it, and any quota?
   | A | All paid plans, all roles per RBAC table (default) | [implication] |
   | B | Specific tier(s): [inferred] | entitlement check required |
   | C | Per-tenant quota: [suggested number] | quota + upgrade path in spec |

   Reply per question or `defaults`.
   ```

   **Recording answers** — every answer lands in the spec, not in a side note:
   - Q1 → User Stories roles + RBAC Roles Affected
   - Q2 → Success Metrics
   - Q3 → Non-Goals
   - Q4 → Story priorities (P1/P2)
   - Q5 → an `IF/THEN` EARS acceptance criterion + Edge Cases
   - Q6 → GDPR / Privacy Classification
   - Q7 → the spec header flag strategy + Rollback Thresholds context
   - Q8 → Assumptions + a quota Edge Case (and an entitlement FR if gated)

   Defaults that were accepted without an explicit answer are recorded in
   Assumptions as "(default — confirm before implementation)"; answers the
   user gave explicitly are recorded as decisions and are NOT re-asked by
   `/speckit-clarify` later.

6. Follow this execution flow:
    1. Parse user description from arguments
       If empty: ERROR "No feature description provided"
    2. Extract key concepts from description
       Identify: actors, actions, data, constraints
    3. For unclear aspects:
       - Make informed guesses based on context and industry standards
       - Only mark with [NEEDS CLARIFICATION: specific question] if:
         - The choice significantly impacts feature scope or user experience
         - Multiple reasonable interpretations exist with different implications
         - No reasonable default exists
       - **LIMIT: Maximum 3 [NEEDS CLARIFICATION] markers total**
       - Prioritize clarifications by impact: scope > security/privacy > user experience > technical details
    4. Fill User Scenarios & Testing section
       If no clear user flow: ERROR "Cannot determine user scenarios"
       Write every acceptance criterion in EARS syntax:
         - Event-driven:  WHEN <trigger>, THE SYSTEM SHALL <response>
         - State-driven:  WHILE <state>, THE SYSTEM SHALL <response>
         - Unwanted:      IF <failure/abuse case>, THEN THE SYSTEM SHALL <response>
         - Optional:      WHERE <feature/flag is present>, THE SYSTEM SHALL <response>
         - Ubiquitous:    THE SYSTEM SHALL <response>
       Every criterion names an observable system response. A criterion that
       fits no EARS pattern is not yet testable — rewrite it or move it to
       Open Questions. Always include at least one Unwanted (IF/THEN)
       criterion per story — failure behavior is part of the story.
    5. Generate Functional Requirements
       Each requirement must be testable — use the same EARS patterns
       Use reasonable defaults for unspecified details (document assumptions in Assumptions section)
    6. Define Success Criteria
       Create measurable, technology-agnostic outcomes
       Include both quantitative metrics (time, performance, volume) and qualitative measures (user satisfaction, task completion)
       Each criterion must be verifiable without implementation details
    7. Identify Key Entities (if data involved)
    8. Return: SUCCESS (spec ready for planning)

7. Write the specification to SPEC_FILE using the template structure, replacing placeholders with concrete details derived from the feature description (arguments) **and the intake interview answers** while preserving section order and headings.

8. **Specification Quality Validation**: After writing the initial spec, validate it against quality criteria:

   a. **Create Spec Quality Checklist**: Generate a checklist file at `SPECIFY_FEATURE_DIRECTORY/checklists/requirements.md` using the checklist template structure with these validation items:

      ```markdown
      # Specification Quality Checklist: [FEATURE NAME]
      
      **Purpose**: Validate specification completeness and quality before proceeding to planning
      **Created**: [DATE]
      **Feature**: [Link to spec.md]
      
      ## Content Quality
      
      - [ ] No implementation details (languages, frameworks, APIs)
      - [ ] Focused on user value and business needs
      - [ ] Written for non-technical stakeholders
      - [ ] All mandatory sections completed
      
      ## Requirement Completeness
      
      - [ ] No [NEEDS CLARIFICATION] markers remain
      - [ ] Requirements are testable and unambiguous
      - [ ] Acceptance criteria use EARS syntax (WHEN/WHILE/IF-THEN/WHERE/SHALL)
      - [ ] Every user story has at least one failure-case (IF/THEN) criterion
      - [ ] Success criteria are measurable
      - [ ] Success criteria are technology-agnostic (no implementation details)
      - [ ] All acceptance scenarios are defined
      - [ ] Edge cases are identified
      - [ ] Scope is clearly bounded
      - [ ] Dependencies and assumptions identified
      
      ## Feature Readiness
      
      - [ ] All functional requirements have clear acceptance criteria
      - [ ] User scenarios cover primary flows
      - [ ] Feature meets measurable outcomes defined in Success Criteria
      - [ ] No implementation details leak into specification
      
      ## Notes
      
      - Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
      ```

   b. **Run Validation Check**: Review the spec against each checklist item:
      - For each item, determine if it passes or fails
      - Document specific issues found (quote relevant spec sections)

   c. **Handle Validation Results**:

      - **If all items pass**: Mark checklist complete and proceed to step 9

      - **If items fail (excluding [NEEDS CLARIFICATION])**:
        1. List the failing items and specific issues
        2. Update the spec to address each issue
        3. Re-run validation until all items pass (max 3 iterations)
        4. If still failing after 3 iterations, document remaining issues in checklist notes and warn user

      - **If [NEEDS CLARIFICATION] markers remain**:
        1. Extract all [NEEDS CLARIFICATION: ...] markers from the spec
        2. **LIMIT CHECK**: If more than 3 markers exist, keep only the 3 most critical (by scope/security/UX impact) and make informed guesses for the rest
        3. For each clarification needed (max 3), present options to user in this format:

           ```markdown
           ## Question [N]: [Topic]
           
           **Context**: [Quote relevant spec section]
           
           **What we need to know**: [Specific question from NEEDS CLARIFICATION marker]
           
           **Suggested Answers**:
           
           | Option | Answer | Implications |
           |--------|--------|--------------|
           | A      | [First suggested answer] | [What this means for the feature] |
           | B      | [Second suggested answer] | [What this means for the feature] |
           | C      | [Third suggested answer] | [What this means for the feature] |
           | Custom | Provide your own answer | [Explain how to provide custom input] |
           
           **Your choice**: _[Wait for user response]_
           ```

        4. **CRITICAL - Table Formatting**: Ensure markdown tables are properly formatted:
           - Use consistent spacing with pipes aligned
           - Each cell should have spaces around content: `| Content |` not `|Content|`
           - Header separator must have at least 3 dashes: `|--------|`
           - Test that the table renders correctly in markdown preview
        5. Number questions sequentially (Q1, Q2, Q3 - max 3 total)
        6. Present all questions together before waiting for responses
        7. Wait for user to respond with their choices for all questions (e.g., "Q1: A, Q2: Custom - [details], Q3: B")
        8. Update the spec by replacing each [NEEDS CLARIFICATION] marker with the user's selected or provided answer
        9. Re-run validation after all clarifications are resolved

   d. **Update Checklist**: After each validation iteration, update the checklist file with current pass/fail status

9. **Report completion** to the user with:
   - `SPECIFY_FEATURE_DIRECTORY` — the feature directory path
   - `SPEC_FILE` — the spec file path
   - A one-paragraph intake summary: which decisions the user made, which
     defaults were taken (so reviewers see them at a glance)
   - Checklist results summary
   - Readiness for the next phase (`/speckit-clarify` or `/speckit-plan`)

10. **Check for extension hooks**: After reporting completion, check if `.specify/extensions.yml` exists in the project root.
   - If it exists, read it and look for entries under the `hooks.after_specify` key
   - If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
   - Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
   - For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
     - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
     - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
   - When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
   - For each executable hook, output the following based on its `optional` flag:
     - **Optional hook** (`optional: true`):
       ```
       ## Extension Hooks

       **Optional Hook**: {extension}
       Command: `/{command}`
       Description: {description}

       Prompt: {prompt}
       To execute: `/{command}`
       ```
     - **Mandatory hook** (`optional: false`):
       ```
       ## Extension Hooks

       **Automatic Hook**: {extension}
       Executing: `/{command}`
       EXECUTE_COMMAND: {command}
       ```
   - If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently

**NOTE:** Branch creation is handled by the `before_specify` hook (git extension). Spec directory and file creation are always handled by this core command.

## Quick Guidelines

- Focus on **WHAT** users need and **WHY**.
- Avoid HOW to implement (no tech stack, APIs, code structure).
- Written for business stakeholders, not developers.
- DO NOT create any checklists that are embedded in the spec. That will be a separate command.

### Section Requirements

- **Mandatory sections**: Must be completed for every feature
- **Optional sections**: Include only when relevant to the feature
- When a section doesn't apply, remove it entirely (don't leave as "N/A")

### For AI Generation

When creating this spec from a user prompt:

1. **Interview first, guess second**: The intake interview (step 5) is where scope, audience, rollout, and privacy get decided — a question answered there is a decision, not an assumption
2. **Make informed guesses** for everything below interview level: use context, industry standards, and common patterns to fill gaps
3. **Document assumptions**: Record reasonable defaults in the Assumptions section, marking untouched interview defaults "(default — confirm before implementation)"
4. **Limit clarifications**: Maximum 3 [NEEDS CLARIFICATION] markers - use only for critical decisions that:
   - Significantly impact feature scope or user experience
   - Have multiple reasonable interpretations with different implications
   - Lack any reasonable default
5. **Prioritize clarifications**: scope > security/privacy > user experience > technical details
6. **Think like a tester**: Every vague requirement should fail the "testable and unambiguous" checklist item
7. **Common areas needing clarification** (only if no reasonable default exists):
   - Feature scope and boundaries (include/exclude specific use cases)
   - User types and permissions (if multiple conflicting interpretations possible)
   - Security/compliance requirements (when legally/financially significant)

**Examples of reasonable defaults** (don't ask about these):

- Data retention: Industry-standard practices for the domain
- Performance targets: Standard web/mobile app expectations unless specified
- Error handling: User-friendly messages with appropriate fallbacks
- Authentication method: Standard session-based or OAuth2 for web apps
- Integration patterns: Use project-appropriate patterns (REST/GraphQL for web services, function calls for libraries, CLI args for tools, etc.)

### Success Criteria Guidelines

Success criteria must be:

1. **Measurable**: Include specific metrics (time, percentage, count, rate)
2. **Technology-agnostic**: No mention of frameworks, languages, databases, or tools
3. **User-focused**: Describe outcomes from user/business perspective, not system internals
4. **Verifiable**: Can be tested/validated without knowing implementation details

**Good examples**:

- "Users can complete checkout in under 3 minutes"
- "System supports 10,000 concurrent users"
- "95% of searches return results in under 1 second"
- "Task completion rate improves by 40%"

**Bad examples** (implementation-focused):

- "API response time is under 200ms" (too technical, use "Users see results instantly")
- "Database can handle 1000 TPS" (implementation detail, use user-facing metric)
- "React components render efficiently" (framework-specific)
- "Redis cache hit rate above 80%" (technology-specific)
