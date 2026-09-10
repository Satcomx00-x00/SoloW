import type { WorkflowStoreEntry } from "./types.js";

/**
 * The three pipelines a fresh Workspace starts with (`ensureDefaultWorkflows` in `@solow/db`):
 * what a Step, a gate and a harness-decided branch are for, ready to attach a Task to. They are
 * store entries like any other — marked `seed` — so the seed and the store cannot disagree
 * about what "Bug fix" is, and a Workspace that deleted one can take it back from the store.
 *
 * None of them bundles a Skill: the seed runs inside the database package, before any library
 * exists, and writes Steps only.
 */
export const DEFAULT_WORKFLOW_ENTRIES: readonly WorkflowStoreEntry[] = [
  {
    id: "implement-and-review",
    seed: true,
    title: "Implement & review",
    description:
      "Implement the issue, then a reviewer harness decides whether it needs another pass.",
    category: "delivery",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Implement",
        prompt:
          "Implement what the issue asks for. Keep the change minimal and consistent with the codebase, and do not touch unrelated files. If this is a later pass, address the reviewer's notes in the handoff above first.",
      },
      {
        name: "Review",
        prompt:
          "Review the previous step's implementation against the issue: correctness, tests, and consistency with the codebase. Do not modify any file. Name every defect precisely in your summary.",
        branch: {
          when: {
            kind: "agent-decides",
            question: "Does the implementation need another pass before it can be merged?",
          },
          yes: "Implement",
          no: null,
        },
      },
    ],
  },
  {
    id: "plan-then-build",
    seed: true,
    title: "Plan, then build",
    description: "A written plan you approve, then the build that follows it.",
    category: "delivery",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Plan",
        gate: "human",
        advanceOn: "review",
        prompt:
          "Study the issue and the codebase, then write a short plan: the files to change, the approach, the tests to add, and the risks. Do not change any file.",
      },
      {
        name: "Build",
        prompt:
          "Carry out the plan in the handoff above. Keep the change focused, and add or update the tests the plan calls for.",
      },
    ],
  },
  {
    id: "bug-fix",
    seed: true,
    title: "Bug fix",
    description: "Reproduce it, fix it, verify it — and loop until the reproduction passes.",
    category: "bugfix",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Reproduce",
        prompt:
          "Reproduce the bug the issue describes: find the failing behaviour and, where possible, write a failing test that captures it. Do not fix it yet. Say exactly how it reproduces in your summary.",
      },
      {
        name: "Fix",
        prompt:
          "Fix the bug so the reproduction in the handoff above passes, changing as little as possible.",
      },
      {
        name: "Verify",
        prompt:
          "Re-run the reproduction and the test suite. Do not modify any file. Report what passed and what did not.",
        branch: {
          when: {
            kind: "agent-decides",
            question: "Does the bug still reproduce, or did the fix break a test?",
          },
          yes: "Fix",
          no: null,
        },
      },
    ],
  },
];
