import type { WorkflowStoreEntry } from "./types.js";

/**
 * The everyday pipelines: shipping, reviewing, refactoring, fixing, testing, maintaining. Each
 * one is the shape a team ends up drawing by hand after a month, written down once.
 *
 * Every Step's prompt is a *brief*, not a conversation: the run loop prepends the previous
 * Step's handoff, so "the handoff above" is how a Step refers to what the last one reported. A
 * Step that must not write says so in its prompt *and* runs in `plan` mode, because a brief is
 * advice and a permission posture is not. The two checklists some Steps read are SoloW's own,
 * kept as markdown under `./skills/` and vendored like every other source.
 */

const ask = (question: string, yes: string | null, no: string | null) => ({
  when: { kind: "agent-decides" as const, question },
  yes,
  no,
});

export const EVERYDAY_WORKFLOWS: readonly WorkflowStoreEntry[] = [
  // ---- Delivery ----
  {
    id: "plan-build-test-review",
    title: "Plan, build, test, review",
    description:
      "A plan you approve, the build that follows it, the tests that prove it, and a reviewer who sends it back if needed.",
    category: "delivery",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Plan",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "Study the issue and the codebase, then write a plan: the files to change, the approach, the tests to add, the risks, and anything you would ask the author. Do not change any file. Keep it short enough to read in two minutes.",
      },
      {
        name: "Build",
        prompt:
          "Carry out the plan in the handoff above. Keep the change focused on what the plan says; if the plan turns out to be wrong somewhere, say so in your summary and do the smallest right thing instead. If this is a later pass, address the reviewer's notes first.",
      },
      {
        name: "Test",
        prompt:
          "Add or update the tests the plan calls for, then run the whole suite. Fix what the new tests reveal in the code you changed; do not weaken a test to make it pass. Report which tests were added and what the suite says.",
      },
      {
        name: "Review",
        permissionMode: "plan",
        prompt:
          "Review the change against the issue and the plan: correctness, tests, scope, and consistency with the codebase. Do not modify any file. Name every defect precisely — file, line, what is wrong, what would fix it.",
        branch: ask("Does the change need another pass before it can be merged?", "Build", null),
      },
    ],
  },
  {
    id: "quick-change",
    title: "Quick change",
    description: "One Step for a change too small to plan: make it, test it, hand it to review.",
    category: "delivery",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Make the change",
        prompt:
          "Make the change the issue asks for, and nothing else. Run the tests that cover it. Say in your summary exactly what changed and what you ran.",
      },
    ],
  },
  {
    id: "spike-then-build",
    title: "Spike, decide, build",
    description:
      "A throwaway exploration that ends in a written recommendation, a human decision, then the real implementation from scratch.",
    category: "delivery",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Spike",
        gate: "human",
        advanceOn: "review",
        prompt:
          "Explore how the issue could be solved: try the one or two approaches that seem plausible, in the roughest code that answers the question. Do not polish and do not write tests. End with a recommendation — which approach, why, what it costs, what you learned — written as if the spike code will be thrown away, because it will.",
      },
      {
        name: "Build",
        prompt:
          "Discard the spike code entirely (revert every file it touched) and implement the recommended approach from the handoff above properly: clean, tested, consistent with the codebase.",
      },
    ],
  },

  // ---- Review ----
  {
    id: "review-then-fix",
    title: "Review, then fix",
    description:
      "A read-only review of the change on the branch, the fixes it asks for, and a verification that loops until the reviewer is satisfied.",
    category: "review",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Review",
        permissionMode: "plan",
        prompt:
          "Review the changes on this branch against its base: correctness first, then tests, then scope and consistency with the codebase. Do not modify any file. List every finding with file, line, what is wrong and what would fix it, ordered by severity.",
        branch: ask("Did the review find anything that must be fixed before merging?", "Fix", null),
      },
      {
        name: "Fix",
        prompt:
          "Address every finding in the handoff above, in order of severity. Change nothing the review did not ask for. Run the tests.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        prompt:
          "Check each finding from the review against the fix: is it addressed, fully, without breaking anything else? Do not modify any file. Name any finding still open.",
        branch: ask("Is any finding still open?", "Fix", null),
      },
    ],
  },
  {
    id: "two-reviewers",
    title: "Two independent reviewers",
    description:
      "Two reviewers who do not see each other's notes, then a third pass that reconciles them into one list — for a change that matters.",
    category: "review",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Reviewer A",
        permissionMode: "plan",
        prompt:
          "Review the changes on this branch for correctness and tests. Do not modify any file. List every finding with file, line and the fix you would make.",
      },
      {
        name: "Reviewer B",
        permissionMode: "plan",
        prompt:
          "Ignore the handoff above — you are a second, independent reviewer. Review the changes on this branch for design, scope, naming and consistency with the codebase. Do not modify any file. List every finding with file, line and the fix you would make.",
      },
      {
        name: "Reconcile",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "Merge the two reviews above into one ordered list: deduplicate, drop what does not hold on a second look, and mark each finding as must-fix or nice-to-have. Do not modify any file.",
      },
      {
        name: "Fix",
        prompt:
          "Address every must-fix finding in the handoff above, and the nice-to-haves that are cheap. Run the tests. Say which findings you did not act on and why.",
      },
    ],
  },
  {
    id: "security-review",
    title: "Security review",
    description:
      "An audit against a checklist, the fixes for what it finds, and a re-audit that loops until nothing is open.",
    category: "review",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: ["security-review-checklist"],
    steps: [
      {
        name: "Audit",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        skills: ["security-review-checklist"],
        prompt:
          "Audit the changes on this branch — or, if the issue names a module, that module — using the security-review-checklist skill. Do not modify any file. Report every finding in the checklist's format, ordered by severity, and say which sections came back clean.",
      },
      {
        name: "Fix",
        skills: ["security-review-checklist"],
        prompt:
          "Fix every finding in the handoff above, highest severity first, with the smallest change that closes it. Add a test for each fix that can be tested. Never weaken validation to make something pass.",
      },
      {
        name: "Re-audit",
        permissionMode: "plan",
        skills: ["security-review-checklist"],
        prompt:
          "Re-check every finding against the fix, and re-run the checklist sections the fix touched. Do not modify any file. Say which findings are closed and which are still open.",
        branch: ask("Is any finding still open?", "Fix", null),
      },
    ],
  },

  // ---- Refactor ----
  {
    id: "refactor-safely",
    title: "Refactor safely",
    description:
      "Pin the current behaviour with tests, change the structure in small steps, verify — and loop until the suite is green.",
    category: "refactor",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: ["refactoring-playbook"],
    steps: [
      {
        name: "Characterise",
        skills: ["refactoring-playbook"],
        prompt:
          "For the code the issue asks to refactor, run the existing tests and record the result. Where behaviour is untested, write characterisation tests that assert what it does today. Do not change the code under test. Report what is now pinned and what already failed before you started.",
      },
      {
        name: "Refactor",
        skills: ["refactoring-playbook"],
        prompt:
          "Refactor as the issue asks, one transformation at a time, running the tests between each. Change no behaviour: the characterisation tests from the handoff above must pass unmodified. If this is a later pass, start with what the verification found.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        skills: ["refactoring-playbook"],
        prompt:
          "Run the full suite. Read the diff and check that nothing behavioural changed and that no test was altered to pass. Do not modify any file. Report what the suite says and anything in the diff that is not a pure restructuring.",
        branch: ask("Did anything fail, or did the diff change behaviour?", "Refactor", null),
      },
    ],
  },
  {
    id: "simplify-a-module",
    title: "Simplify a module",
    description:
      "A survey of what could be simpler, which you approve, then the simplification and its verification.",
    category: "refactor",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: ["refactoring-playbook"],
    steps: [
      {
        name: "Survey",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "Read the module the issue names and list what could be simpler: duplicated logic, dead code, needless indirection, conditions that could be flattened, names that lie. For each, say what you would do, what it risks, and how big the change is. Do not modify any file. Order the list by value over risk.",
      },
      {
        name: "Simplify",
        skills: ["refactoring-playbook"],
        prompt:
          "Apply the simplifications from the handoff above that were approved, one at a time, running the tests between each. Change no behaviour.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        prompt:
          "Run the full suite and read the diff. Do not modify any file. Confirm each approved simplification was made, that nothing else changed, and that the code reads better than before — or say where it does not.",
        branch: ask(
          "Did anything fail, or was an approved simplification missed?",
          "Simplify",
          null,
        ),
      },
    ],
  },
  {
    id: "migrate-callers",
    title: "Migrate callers",
    description:
      "Replace an API, a library or a pattern across the codebase: inventory every use, migrate them, remove the old thing, verify.",
    category: "refactor",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: ["refactoring-playbook"],
    steps: [
      {
        name: "Inventory",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "Find every use of the thing the issue asks to replace. List them by file with a one-line note on how each is used and whether the replacement is mechanical or needs thought. Do not modify any file. State the order you would migrate in and what could break.",
      },
      {
        name: "Migrate",
        skills: ["refactoring-playbook"],
        prompt:
          "Migrate every use in the inventory above to the replacement, keeping the old one available until the last caller is gone. Run the tests after each group of files. Leave the old thing in place for the next Step.",
      },
      {
        name: "Remove",
        prompt:
          "Remove the old API, dependency or pattern now that nothing uses it: code, config, docs, and any compatibility shim the migration added. Run the tests.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        prompt:
          "Search the whole codebase for any remaining use of the old thing, run the full suite, and read the diff. Do not modify any file. Report anything left behind.",
        branch: ask(
          "Is any use of the old thing still there, or did a test fail?",
          "Migrate",
          null,
        ),
      },
    ],
  },

  // ---- Bug fix ----
  {
    id: "hotfix",
    title: "Hotfix",
    description:
      "Diagnose and propose the smallest patch, which you approve before it is written; then patch and verify, looping until the reproduction passes.",
    category: "bugfix",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Diagnose",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "Find the root cause of the bug the issue describes: reproduce it, trace it to the line, and explain why it happens. Do not modify any file. Propose the smallest patch that fixes the cause — not the symptom — as a precise description of the change, and say what it could break.",
      },
      {
        name: "Patch",
        prompt:
          "Apply the approved patch from the handoff above, exactly as described, and add a regression test that fails without it. Change nothing else.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        prompt:
          "Run the regression test and the full suite. Do not modify any file. Report what passed, what did not, and whether the diff is limited to the approved patch.",
        branch: ask("Does the bug still reproduce, or did the patch break a test?", "Patch", null),
      },
    ],
  },
  {
    id: "flaky-test",
    title: "Flaky test hunt",
    description:
      "Reproduce the flake, find its cause — timing, order, shared state — fix it, and prove it by running the test many times.",
    category: "bugfix",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Reproduce",
        prompt:
          "Make the flaky test the issue names fail on demand: run it repeatedly, in isolation and with its neighbours, under load, with a fixed seed. Do not fix it. Report exactly what makes it fail and how often.",
      },
      {
        name: "Diagnose",
        permissionMode: "plan",
        prompt:
          "From the reproduction in the handoff above, find the cause: a race, an order dependency, shared state, a real clock, an unawaited promise, a leaked resource. Do not modify any file. Name the cause and the fix you would make — to the test if the test is wrong, to the code if the code is.",
      },
      {
        name: "Fix",
        prompt:
          "Make the fix from the handoff above. Do not add retries, sleeps or a longer timeout unless the diagnosis says the timing itself is the bug. Change nothing else.",
      },
      {
        name: "Prove",
        permissionMode: "plan",
        prompt:
          "Run the test at least fifty times, in the way that used to make it fail. Run the full suite once. Do not modify any file. Report the counts.",
        branch: ask("Did the test fail even once, or did the suite break?", "Fix", null),
      },
    ],
  },

  // ---- Quality ----
  {
    id: "red-green-refactor",
    title: "Red, green, refactor",
    description:
      "Test-driven, one behaviour at a time: a failing test, the least code that passes it, a tidy-up — and back to red until the issue is done.",
    category: "quality",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Red",
        prompt:
          "Pick the next behaviour the issue asks for that is not yet covered — the handoff above says what is done so far. Write one failing test for it and run it to see it fail for the right reason. Do not write any production code. Report the test and the failure.",
      },
      {
        name: "Green",
        prompt:
          "Write the least production code that makes the test in the handoff above pass. Do not generalise, do not refactor, do not touch other tests. Run the suite and report.",
      },
      {
        name: "Refactor",
        prompt:
          "With the suite green, tidy what the last two Steps wrote: names, duplication, structure. Change no behaviour; run the suite. Then list what the issue asks for that is still uncovered.",
        branch: ask("Does the issue ask for a behaviour that is not yet covered?", "Red", null),
      },
    ],
  },
  {
    id: "raise-test-coverage",
    title: "Raise test coverage",
    description:
      "Map what is untested and why it matters, agree on the targets, write the tests, and have them reviewed for meaning rather than count.",
    category: "quality",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Map gaps",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "For the module the issue names, find what is untested: run coverage if the project has it, otherwise read the code and the tests side by side. Do not modify any file. List the gaps ordered by risk — what would break silently — with the test you would write for each.",
      },
      {
        name: "Write tests",
        prompt:
          "Write the approved tests from the handoff above, in the project's existing style and framework. Each test must fail if the behaviour it names is broken — check by reading, not by assuming. Do not change production code except to make something testable, and say so if you do.",
      },
      {
        name: "Review",
        permissionMode: "plan",
        prompt:
          "Read every new test. Do not modify any file. For each: does it assert behaviour or implementation? Would it catch a real regression? Is it clear what failed when it fails? Name the tests that are not worth keeping and why.",
        branch: ask(
          "Do any of the new tests need to be rewritten or removed?",
          "Write tests",
          null,
        ),
      },
    ],
  },
  {
    id: "performance-pass",
    title: "Performance pass",
    description:
      "Measure before touching anything, optimise the one thing the profile blames, measure again — and stop when the numbers say so.",
    category: "quality",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Profile",
        gate: "human",
        advanceOn: "review",
        prompt:
          "Establish a reproducible measurement for the slowness the issue describes — a benchmark, a timed script, a profiler run — and record the baseline numbers. Then find where the time actually goes. Do not optimise anything. Report the baseline, the hot spots, and the one change you would try first.",
      },
      {
        name: "Optimise",
        prompt:
          "Make the approved change from the handoff above, and only that one. Keep behaviour identical; run the tests.",
      },
      {
        name: "Measure",
        permissionMode: "plan",
        prompt:
          "Re-run the same measurement as the baseline, the same way. Do not modify any file. Report before and after, and whether the gain is worth the complexity the change added.",
        branch: ask("Is there another hot spot worth a pass, given the numbers?", "Optimise", null),
      },
    ],
  },

  // ---- Maintenance ----
  {
    id: "dependency-upgrade",
    title: "Dependency upgrade",
    description:
      "Audit what is outdated or vulnerable, upgrade in order of risk, verify — and loop while something breaks.",
    category: "maintenance",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Audit",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "List the dependencies the issue names — or every outdated or vulnerable one, if it names none — with current and target versions, the changelog entries that matter, and the breaking changes. Do not modify any file. Propose an order: security fixes, then patch, then minor, then majors one at a time.",
      },
      {
        name: "Upgrade",
        prompt:
          "Upgrade in the approved order from the handoff above, running the build and the tests after each. Adapt call sites to breaking changes with the smallest change. Stop and report if a major cannot be made to pass, rather than pinning it back silently.",
      },
      {
        name: "Verify",
        permissionMode: "plan",
        prompt:
          "Run the full build, the tests, and the project's audit for advisories. Do not modify any file. Report what is upgraded, what is still outstanding, and anything new the audit reports.",
        branch: ask(
          "Did a build or test fail, or is an approved upgrade still outstanding?",
          "Upgrade",
          null,
        ),
      },
    ],
  },
  {
    id: "document-a-module",
    title: "Document a module",
    description:
      "Read the code as a newcomer would, write the documentation it lacks, and have it checked against the code rather than against itself.",
    category: "maintenance",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Read",
        gate: "human",
        advanceOn: "review",
        permissionMode: "plan",
        prompt:
          "Read the module the issue names as someone new to it. Do not modify any file. List what a reader needs and cannot find: what it is for, how to use it, its invariants, the non-obvious decisions. Propose which documents to write or update and in what form the project already uses.",
      },
      {
        name: "Write",
        prompt:
          "Write the approved documentation from the handoff above, in the project's existing style and location. Explain why, not what — the code says what. Every example must actually run.",
      },
      {
        name: "Check",
        permissionMode: "plan",
        prompt:
          "Check every statement in the new documentation against the code, and run every example. Do not modify any file. Name anything that is wrong, out of date, or says less than the code does.",
        branch: ask("Is anything in the documentation wrong or missing?", "Write", null),
      },
    ],
  },
  {
    id: "onboard-a-codebase",
    title: "Onboard a codebase",
    description:
      "For a repository nobody has explained: map its shape, write the guide a first contributor needs, and verify the setup steps actually work.",
    category: "maintenance",
    vendor: "SoloW",
    homepage: "https://github.com/Satcomx00-x00/SoloW",
    skills: [],
    steps: [
      {
        name: "Map",
        permissionMode: "plan",
        prompt:
          "Explore the repository: its purpose, the main modules and how they depend on each other, how it is built, tested and run, and where the conventions live. Do not modify any file. Write your findings as a structured map, and list what you could not work out.",
      },
      {
        name: "Write the guide",
        gate: "human",
        advanceOn: "review",
        prompt:
          "From the map in the handoff above, write or update the contributor guide the project uses (a CLAUDE.md, a CONTRIBUTING.md, a docs page): what the project is, how to set it up, how to run the tests, where things are, and the conventions to follow. Say only what you verified.",
      },
      {
        name: "Verify setup",
        prompt:
          "Follow the guide's setup and test instructions literally, from a clean state where possible. Fix the guide where it is wrong. Report which steps worked as written and which you had to change.",
      },
    ],
  },
];
