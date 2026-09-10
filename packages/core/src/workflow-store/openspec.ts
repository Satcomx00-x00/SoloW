import type { WorkflowStoreEntry } from "./types.js";

/**
 * OpenSpec (Fission-AI/OpenSpec), as a pipeline: explore → propose → apply → verify → archive.
 * OpenSpec keeps the live requirements under `openspec/specs/` and every change as a folder of
 * artifacts under `openspec/changes/<name>/` — a proposal, a design, a task list and the spec
 * deltas — that is merged into the live specs when the change is archived. Each Step loads the
 * Skill for its stage: OpenSpec's own `skills/openspec-<name>/SKILL.md`, vendored from
 * `Fission-AI/OpenSpec` at build time under the names `openspec init` installs them as, so a
 * library that already holds them keeps them.
 */

export const OPENSPEC_WORKFLOWS: readonly WorkflowStoreEntry[] = [
  {
    id: "openspec-change",
    title: "OpenSpec — propose, apply, verify, archive",
    description:
      "OpenSpec's artifact-driven change: explore the ground, propose the requirements you approve, apply the tasks, verify scenario by scenario, then merge the deltas into the live specs.",
    category: "methodology",
    vendor: "Fission-AI/OpenSpec",
    homepage: "https://github.com/Fission-AI/OpenSpec",
    skills: [
      "openspec-explore",
      "openspec-propose",
      "openspec-apply-change",
      "openspec-verify-change",
      "openspec-archive-change",
    ],
    steps: [
      {
        name: "Explore",
        permissionMode: "plan",
        skills: ["openspec-explore"],
        prompt:
          "Using the openspec-explore skill, investigate the live specs and the code around what the issue asks for, and shape the change. Modify no file. Your summary is the shaped change with its assumptions and risks.",
      },
      {
        name: "Propose",
        gate: "human",
        advanceOn: "review",
        skills: ["openspec-propose"],
        prompt:
          "Using the openspec-propose skill and the shaped change in the handoff above, create the change folder: proposal, design if needed, spec deltas with scenarios, and the task list. Implement nothing. Your summary is the proposal in brief, so the reviewer approves the requirements before any code.",
      },
      {
        name: "Apply",
        skills: ["openspec-apply-change"],
        prompt:
          "Using the openspec-apply-change skill, implement the approved change by working through its tasks.md in order. If this is a later pass, start with the failures the verification in the handoff above reported. Report tasks done, tests added and every deviation.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        skills: ["openspec-verify-change"],
        prompt:
          "Using the openspec-verify-change skill, check every scenario of the change's spec deltas and every ticked task against the implementation, with evidence. Modify no file. Put the verdict table in your summary.",
        branch: {
          when: {
            kind: "agent-decides",
            question: "Did any scenario fail, or is any ticked task unaccounted for?",
          },
          yes: "Apply",
          no: "Archive",
        },
      },
      {
        name: "Archive",
        skills: ["openspec-archive-change"],
        prompt:
          "Using the openspec-archive-change skill, merge the change's spec deltas into the live specs and move the change folder to the archive. Your summary names every live spec that changed and the archive path.",
      },
    ],
  },
];
