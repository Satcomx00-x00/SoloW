/**
 * Where the store's Skills come from (spec F03). None of their text lives in this package's
 * source: `scripts/sync-workflow-store.ts` reads this manifest, fetches each file from the
 * repository that owns it — or from `./skills/` for the ones SoloW owns — validates it, and
 * writes `vendored.generated.json`, which the catalog reads. CI runs that sync before it builds,
 * so a release carries the upstream text as it was on the day, and refuses to build when a
 * source cannot be fetched or fails validation.
 *
 * Hand-written and reviewed: a line here decides what a harness reads with the run's
 * credentials, so a new source or a new file is a pull request, never a discovery.
 */

/** How a fetched file is turned into a Skill. */
export type VendoredSkillFormat =
  /** A `SKILL.md` as every harness reads it: frontmatter with `name` and `description`. */
  | "skill"
  /**
   * A Spec Kit command template (`templates/commands/*.md`): frontmatter with `description`
   * (and `scripts`/`handoffs` the harness cannot use), a body with `$ARGUMENTS`, `{SCRIPT}` and
   * `__AGENT__` placeholders — resolved the way `specify init` resolves them.
   */
  | "speckit-command";

export type VendoredSkillSpec = {
  /** The library name (`libraryNameSchema`), which is also the key in the generated file. */
  name: string;
  /** Path inside the repository, or inside `./skills/` for a local source. */
  path: string;
  format: VendoredSkillFormat;
};

export type WorkflowStoreSource = {
  id: string;
  title: string;
  /** SPDX identifier of the upstream licence, so the notice the release ships can name it. */
  license: string;
} & (
  | {
      kind: "repository";
      /** `owner/name` on GitHub. */
      repository: string;
      /** The branch or tag the sync reads; `main` follows the upstream, a tag pins it. */
      ref: string;
      skills: readonly VendoredSkillSpec[];
    }
  | {
      kind: "local";
      skills: readonly VendoredSkillSpec[];
    }
);

const speckit = (command: string): VendoredSkillSpec => ({
  name: `speckit-${command}`,
  path: `templates/commands/${command}.md`,
  format: "speckit-command",
});
const skillDir = (name: string, dir = "skills"): VendoredSkillSpec => ({
  name,
  path: `${dir}/${name}/SKILL.md`,
  format: "skill",
});
const local = (name: string): VendoredSkillSpec => ({
  name,
  path: `${name}.md`,
  format: "skill",
});

export const WORKFLOW_STORE_SOURCES: readonly WorkflowStoreSource[] = [
  {
    id: "speckit",
    title: "GitHub Spec Kit",
    license: "MIT",
    kind: "repository",
    repository: "github/spec-kit",
    ref: "main",
    skills: ["specify", "clarify", "plan", "tasks", "analyze", "implement"].map(speckit),
  },
  {
    id: "superpowers",
    title: "Superpowers",
    license: "MIT",
    kind: "repository",
    repository: "obra/superpowers",
    ref: "main",
    skills: [
      "brainstorming",
      "writing-plans",
      "executing-plans",
      "test-driven-development",
      "systematic-debugging",
      "verification-before-completion",
      "requesting-code-review",
      "receiving-code-review",
      "finishing-a-development-branch",
    ].map((name) => skillDir(name)),
  },
  {
    id: "openspec",
    title: "OpenSpec",
    license: "MIT",
    kind: "repository",
    repository: "Fission-AI/OpenSpec",
    ref: "main",
    skills: [
      "openspec-explore",
      "openspec-propose",
      "openspec-apply-change",
      "openspec-verify-change",
      "openspec-archive-change",
    ].map((name) => skillDir(name)),
  },
  {
    // SoloW's own: the everyday checklists, and the one Spec Kit phase upstream has no command
    // for (`verify` — the loop-closing evidence report after `implement`).
    id: "solow",
    title: "SoloW",
    license: "Apache-2.0",
    kind: "local",
    skills: ["security-review-checklist", "refactoring-playbook", "speckit-verify"].map(local),
  },
];

/** One Skill as the generated file holds it: the text, and enough provenance to audit it. */
export type VendoredSkill = {
  source: string;
  path: string;
  description: string;
  /** The `SKILL.md` body — frontmatter stripped, placeholders resolved. */
  body: string;
  /** SHA-256 of `body`, so a hand edit to the generated file is caught by `store:check`. */
  sha256: string;
};

export type VendoredStore = {
  generatedAt: string;
  sources: Record<
    string,
    { repository: string | null; ref: string | null; commit: string | null; license: string }
  >;
  skills: Record<string, VendoredSkill>;
};
