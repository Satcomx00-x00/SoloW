import type { WorkflowStoreEntry } from "./types.js";

/**
 * GitHub's Spec Kit, as a pipeline: specify → clarify → plan → tasks → analyze → implement →
 * verify, each phase a Step reading the Skill for that phase. Six of the seven are Spec Kit's
 * own command templates (`templates/commands/*.md`), vendored from `github/spec-kit` at build
 * time and turned into Skills the way `specify init` turns them into commands; `speckit-verify`
 * is SoloW's, because upstream has no command that closes the loop with evidence after
 * `implement`. One difference of setting, said in each Step's brief: a Spec Kit command asks its
 * questions in the chat, while a Step runs to completion and hands off — so a question becomes a
 * written recommendation for the person at the gate.
 */

export const SPECKIT_WORKFLOWS: readonly WorkflowStoreEntry[] = [
  {
    id: "speckit-sdd",
    title: "Spec Kit — spec-driven development",
    description:
      "GitHub's Spec Kit as a pipeline: specify, clarify, plan, tasks, analyze, implement, verify — with a human gate on every artifact you would want to read.",
    category: "methodology",
    vendor: "GitHub Spec Kit",
    homepage: "https://github.com/github/spec-kit",
    skills: [
      "speckit-specify",
      "speckit-clarify",
      "speckit-plan",
      "speckit-tasks",
      "speckit-analyze",
      "speckit-implement",
      "speckit-verify",
    ],
    steps: [
      {
        name: "Specify",
        gate: "human",
        advanceOn: "review",
        skills: ["speckit-specify"],
        prompt:
          "Using the speckit-specify skill, write the feature specification for what the issue describes. Say in your summary where the spec is, which user story is P1, and every [NEEDS CLARIFICATION] you left.",
      },
      {
        name: "Clarify",
        gate: "human",
        advanceOn: "review",
        skills: ["speckit-clarify"],
        prompt:
          "Using the speckit-clarify skill, find what the spec leaves open, apply your recommended answers, and record them in the spec. Your summary lists each question and the answer you applied, so the reviewer can overrule any of them by sending this Step back with the right one.",
      },
      {
        name: "Plan",
        gate: "human",
        advanceOn: "review",
        skills: ["speckit-plan"],
        prompt:
          "Using the speckit-plan skill, write plan.md and its design artifacts from the approved spec. If this is a later pass, start from the analysis findings in the handoff above. Your summary names the technical decisions and any constitution trade-off.",
      },
      {
        name: "Tasks",
        skills: ["speckit-tasks"],
        prompt:
          "Using the speckit-tasks skill, generate tasks.md from the plan and the design artifacts. Say how many tasks, per story, and which story is the MVP.",
      },
      {
        name: "Analyze",
        permissionMode: "plan",
        skills: ["speckit-analyze"],
        prompt:
          "Using the speckit-analyze skill, check spec.md, plan.md and tasks.md against each other and against the constitution. Modify nothing. Put the full report in your summary.",
        branch: {
          when: {
            kind: "agent-decides",
            question: "Did the analysis report any CRITICAL or HIGH finding?",
          },
          yes: "Remediate",
          no: "Implement",
        },
      },
      {
        name: "Remediate",
        skills: ["speckit-specify", "speckit-plan", "speckit-tasks"],
        prompt:
          "Fix every CRITICAL and HIGH finding from the analysis in the handoff above, in the artifact that owns it — spec.md, plan.md or tasks.md — with the smallest edit that closes it. Do not implement anything. List what you changed.",
        branch: {
          when: { kind: "agent-decides", question: "Did you change any artifact?" },
          yes: "Analyze",
          no: "Implement",
        },
      },
      {
        name: "Implement",
        skills: ["speckit-implement"],
        prompt:
          "Using the speckit-implement skill, execute tasks.md phase by phase. If this is a later pass, start with the failures in the verify report from the handoff above. Summary: what was completed, what deviated from the plan, what is left.",
      },
      {
        name: "Verify",
        skills: ["speckit-verify"],
        prompt:
          "Using the speckit-verify skill, write verify-report.md with evidence for every success criterion and acceptance scenario. Modify no other file. Put the verdict table in your summary.",
        branch: {
          when: {
            kind: "agent-decides",
            question: "Did any success criterion or acceptance scenario fail?",
          },
          yes: "Implement",
          no: null,
        },
      },
    ],
  },
];
