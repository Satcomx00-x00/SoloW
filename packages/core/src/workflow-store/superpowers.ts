import type { WorkflowStoreEntry } from "./types.js";

/**
 * Superpowers (obra/superpowers), as pipelines. Superpowers is a set of Skills that a harness
 * is meant to reach for in a fixed order — brainstorm, plan, execute test-first, verify, ask
 * for review, finish the branch — and that order is exactly a Workflow. Each Step here loads
 * the Skill for its phase, under the upstream Skill's own name, with the upstream text: the
 * `SKILL.md` files are vendored from `obra/superpowers` at build time (`WORKFLOW_STORE_SOURCES`).
 * A library that already holds a Skill of that name — a directory import of the whole plugin,
 * which also carries the sibling files some of them refer to — keeps it, and the Steps bind to it.
 *
 * The one deliberate difference: Superpowers ends by choosing between merging and opening a
 * pull request. SoloW integrates a Task on the reviewer's approval, so the last Step readies the
 * branch and hands over, rather than merging.
 */

const decide = (question: string, yes: string | null, no: string | null) => ({
  when: { kind: "agent-decides" as const, question },
  yes,
  no,
});

export const SUPERPOWERS_WORKFLOWS: readonly WorkflowStoreEntry[] = [
  {
    id: "superpowers-feature",
    title: "Superpowers — brainstorm to branch",
    description:
      "The Superpowers way, end to end: brainstorm a design you approve, write a plan you approve, execute it test-first, verify, review, and ready the branch.",
    category: "methodology",
    vendor: "obra/superpowers",
    homepage: "https://github.com/obra/superpowers",
    skills: [
      "brainstorming",
      "writing-plans",
      "executing-plans",
      "test-driven-development",
      "verification-before-completion",
      "requesting-code-review",
      "receiving-code-review",
      "finishing-a-development-branch",
    ],
    steps: [
      {
        name: "Brainstorm",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        skills: ["brainstorming"],
        prompt:
          "Using the brainstorming skill, turn the issue into a design: explore the codebase, write the questions you would ask with the answer you assume for each, compare the approaches, and write the design. Do not write production code. Your summary is the design and the assumptions, so the reviewer can correct either.",
      },
      {
        name: "Write plan",
        gate: "human",
        advanceOn: "review",
        skills: ["writing-plans"],
        prompt:
          "Using the writing-plans skill, turn the approved design in the handoff above into a plan of bite-sized, test-first tasks with exact file paths. Write it where the project keeps plans. Do not implement anything. Your summary lists the tasks.",
      },
      {
        name: "Execute",
        skills: ["executing-plans", "test-driven-development"],
        prompt:
          "Using the executing-plans and test-driven-development skills, carry out the plan task by task — failing test, least code, refactor, checkpoint. If this is a later pass, start with what the verification or the review in the handoff above asked for, using the receiving-code-review skill's judgement. Report every deviation.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        skills: ["verification-before-completion"],
        prompt:
          "Using the verification-before-completion skill, run every check the project has and exercise the change as a user would. Modify no file. Report exactly what you ran and what it printed.",
        branch: decide(
          "Did any check fail, or is anything left unverified that could be verified?",
          "Execute",
          "Review",
        ),
      },
      {
        name: "Review",
        permissionMode: "plan",
        skills: ["requesting-code-review"],
        prompt:
          "Using the requesting-code-review skill, review the branch against the plan and then for quality. Modify no file. Report every issue with severity, file, line and fix, and give the verdict.",
        branch: decide(
          "Does the change need another pass before it is ready to merge?",
          "Execute",
          "Finish",
        ),
      },
      {
        name: "Finish",
        skills: ["finishing-a-development-branch"],
        prompt:
          "Using the finishing-a-development-branch skill, ready the branch for integration: green from clean, a diff you have read whole, tidy history if the project wants one, the docs and changelog it expects. Your summary is the handoff to the person approving the merge.",
      },
    ],
  },
  {
    id: "superpowers-debugging",
    title: "Superpowers — systematic debugging",
    description:
      "Reproduce, isolate, hypothesise, fix at the cause with a test — and verify before calling it done, looping until the reproduction passes.",
    category: "methodology",
    vendor: "obra/superpowers",
    homepage: "https://github.com/obra/superpowers",
    skills: ["systematic-debugging", "test-driven-development", "verification-before-completion"],
    steps: [
      {
        name: "Reproduce and isolate",
        gate: "human",
        advanceOn: "review",
        skills: ["systematic-debugging"],
        prompt:
          "Using the systematic-debugging skill, work Phases 1 to 3 on the bug the issue describes: reproduce it on demand, isolate it, and state the cause as a tested hypothesis. Write a test that reproduces it if you can; change no production code. Your summary is the reproduction, the isolation, the hypotheses tried and the cause.",
      },
      {
        name: "Fix",
        skills: ["systematic-debugging", "test-driven-development"],
        prompt:
          "Using the systematic-debugging skill's Phase 4 and test-driven-development, fix the cause named in the handoff above: a failing test first, then the smallest change that makes it pass, then the full suite, then a look for the same cause elsewhere.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        skills: ["verification-before-completion"],
        prompt:
          "Using the verification-before-completion skill, run the original reproduction, the new test and the full suite, and read the diff. Modify no file. Report what you ran and what it printed.",
        branch: decide("Does the bug still reproduce, or did the fix break anything?", "Fix", null),
      },
    ],
  },
];
