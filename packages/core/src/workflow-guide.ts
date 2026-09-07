/**
 * How to build a Workflow through the API — the text `workflow.authoringGuide` returns, so an
 * AI holding a SoloW MCP token can read the rules once and then call the tools (spec F03).
 *
 * Kept as prose in one place rather than scattered across tool descriptions: the graph rules
 * (`validateWorkflowGraph`), the branch shape and the gate/advance vocabulary are the same
 * three things a person learns from the designer, and a builder that cannot see the canvas has
 * to be told them. Pure text, so the product can test that it names what it must.
 */
export const WORKFLOW_AUTHORING_GUIDE = `# Building a Workflow in SoloW

A Workflow is an ordered pipeline of Steps. A Task attached to it runs one Step at a time, each
Step on its own harness session, and the handoff (summary, diff, decision) travels to the next.

## The tools, in the order you use them

1. \`workflow_list\` / \`workflow_get\` — see what exists. Do not create a second pipeline with a name
   that is already there.
2. \`workflow_create\` — \`{ name, description? }\`. Returns the Workflow; note its \`id\`.
3. \`workflow_addStep\` — one call per Step, in pipeline order. Omit \`afterStepId\` to append.
   Fields:
   - \`name\` — short, imperative ("Implement", "Review", "Verify").
   - \`agentProfileId\` — a Harness Profile of this Workspace (\`profile_list\`).
   - \`promptTemplate\` — what the harness is told for this Step. Write it for a harness that has
     just read the issue and the handoff of the previous Step; say what to do, what not to touch,
     and what its summary must report.
   - \`gate\` — \`"auto"\` (advance on its own), \`"human"\` (a person approves before advancing),
     \`"auto-unless-changes"\` (automatic unless the Step produced a diff).
   - \`advanceOn\` — \`"agent-signal"\` (the harness says it is done) or \`"review"\` (a review lands).
   - \`mcpServerIds\` / \`skillIds\` — library items loaded for this Step on top of the
     Workspace-wide ones (\`library_mcp_list\`, \`library_skill_list\`). Additive; ids only.
4. \`workflow_updateStep\` with \`branch\` — after every Step exists, add the conditions:
   \`{ when, thenStepId, elseStepId }\`, where \`when\` is either
   \`{ kind: "agent-decides", question: "…?" }\` (the Step's harness answers yes or no at the end of
   its run) or \`{ kind: "produced-changes" }\` (the Step left a diff). \`thenStepId\` and
   \`elseStepId\` are Step ids of this Workflow, or \`null\` for "the pipeline ends". A backward
   target makes a loop; the run loop bounds loops, so a "needs another pass?" → back to
   "Implement" branch is the normal shape of a review.
5. \`workflow_reorderStep\` — move a Step: \`{ stepId, afterStepId, beforeStepId }\`, nulls for the ends.
6. \`workflow_attachTask\` — \`{ taskId, workflowId }\` binds a Task (backlog or ready) to the
   pipeline; \`task_launch\` then starts it at the first Step. \`workflow_detachTask\` unbinds.

## Rules the graph must satisfy (the API refuses what breaks them)

- Exactly one start: the first Step by rank is where every Task enters. There is no second entry.
- Exactly one end: a Step whose exits all point at \`null\` — or the last Step by rank with no
  branch — ends the pipeline. Completion always needs a human's approval at the review gate.
- Every Step must be reachable from the start, and every Step must have a way out
  (\`WORKFLOW_GRAPH_INVALID\` otherwise).
- A Step cannot branch to itself (\`WORKFLOW_BRANCH_TARGET_IS_SELF\`); a Step that another Step
  branches to cannot be deleted until that branch is re-pointed (\`WORKFLOW_STEP_BRANCHED_TO\`).
- Ranks are the API's: never send positions; use \`afterStepId\` / \`beforeStepId\`.

## What you cannot do from here

Advancing a Task through its gates (\`workflow.advanceTask\`) and deciding a review are withheld
from MCP on purpose: the party holding this token is the party whose work the gates hold.
Build the pipeline, attach the Task, launch it — a person opens the gates.

## A worked example

Implement & review:
1. \`workflow_create { name: "Implement & review" }\` → \`W\`.
2. \`workflow_addStep { workflowId: W, name: "Implement", agentProfileId: P, gate: "auto",
   advanceOn: "agent-signal", promptTemplate: "Implement what the issue asks for…" }\` → \`S1\`.
3. \`workflow_addStep { …, name: "Review", promptTemplate: "Review the previous step's
   implementation… Do not modify files." }\` → \`S2\`.
4. \`workflow_updateStep { stepId: S2, branch: { when: { kind: "agent-decides", question: "Does
   the implementation need another pass before it can be merged?" }, thenStepId: S1,
   elseStepId: null } }\`.
5. \`workflow_get { id: W }\` — confirm two Steps and the branch; then attach a Task and launch it.
`;
