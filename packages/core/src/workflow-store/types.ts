import type {
  HarnessPermissionMode,
  WorkflowAdvanceOn,
  WorkflowStepCondition,
  WorkflowStepGate,
} from "@solow/contracts";

/**
 * The Workflow store (spec F03): pipelines described once, installed into a Workspace with a
 * click — the `MCP_STORE` idea applied to Workflows. An entry is a *recipe*: its Steps, their
 * gates and branches, and the names of the Skills those Steps read. Installing one writes an ordinary Workflow
 * the operator can edit on the canvas, and adds to the library whatever bundled Skill it does not
 * already hold **by name** — so a Skill imported from the method's own repository beforehand
 * (Settings → Skills → Import) is the one the Step binds to, and the bundled text is only the
 * fallback for a library that has nothing of that name.
 *
 * Curated by hand, not fetched: what this catalog says is the brief a harness runs on with the
 * run's credentials, so it is reviewed in a pull request rather than taken from a registry.
 */

export type WorkflowStoreCategory =
  | "delivery"
  | "review"
  | "refactor"
  | "bugfix"
  | "quality"
  | "maintenance"
  | "methodology";

/**
 * A Skill an entry brings with it, resolved from `vendored.generated.json` — the text a source
 * repository publishes, fetched by `scripts/sync-workflow-store.ts`, never typed here. Written
 * into the library as inline text under this name.
 */
export type WorkflowStoreSkill = {
  /** A library name (`libraryNameSchema`): the directory the harness reads it from. */
  name: string;
  description: string;
  body: string;
};

/**
 * A Step as the catalog writes it: the document's Step with the noise taken out. Branch targets
 * are Step *names* here — an index is what the document carries, but a recipe that reads
 * "yes goes back to Implement" is one a reviewer can check against the prose beside it.
 */
export type WorkflowStoreStep = {
  name: string;
  prompt: string;
  /** Default `auto`: an intermediate Step waits for a person only when the recipe says so. */
  gate?: WorkflowStepGate;
  /** Default `agent-signal`; `review` for a Step whose gate is `human`. */
  advanceOn?: WorkflowAdvanceOn;
  /** Names of Skills — every one of them listed on the entry, and vendored. */
  skills?: readonly string[];
  permissionMode?: HarnessPermissionMode | null;
  /** `yes`/`no` name a Step of the same entry, or null for "the pipeline ends here" — the canvas's two exits. */
  branch?: { when: WorkflowStepCondition; yes: string | null; no: string | null };
};

export type WorkflowStoreEntry = {
  id: string;
  /** The Workflow name the install writes — suffixed if the Workspace already has one. */
  title: string;
  description: string;
  category: WorkflowStoreCategory;
  /** Seeded into a Workspace that has no Workflow yet (`ensureDefaultWorkflows`). Bundles no Skill. */
  seed?: boolean;
  vendor: string;
  homepage: string;
  steps: readonly WorkflowStoreStep[];
  /** Every Skill its Steps name, by vendored name (`WORKFLOW_STORE_SOURCES`). */
  skills: readonly string[];
};
