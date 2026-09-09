import type {
  WorkflowDocument,
  WorkflowDocumentStep,
  WorkflowStepBranch,
  WorkflowStepCondition,
} from "@solow/contracts";
import { WORKFLOW_DOCUMENT_FORMAT, WORKFLOW_DOCUMENT_VERSION } from "@solow/contracts";

/**
 * Turning a Workflow into a shareable document and back (see `workflowDocumentSchema`).
 *
 * Both directions are pure and live here rather than in the DAL for the reason the rank rules do:
 * the interesting part is the *translation* — ids to names, ids to indices, and what happens when
 * a name resolves to nothing — and a translation that can only be tested through a database is a
 * translation nobody re-reads. The DAL supplies the two catalogues and writes the rows.
 */

/** A Step as it comes off the wire, reduced to the fields a document carries. */
export interface ExportableStep {
  id: string;
  name: string;
  agentProfileId: string;
  promptTemplate: string;
  gate: WorkflowDocumentStep["gate"];
  advanceOn: WorkflowDocumentStep["advanceOn"];
  onEnter: WorkflowDocumentStep["onEnter"];
  branch: WorkflowStepBranch | null;
  mcpServerIds: readonly string[];
  skillIds: readonly string[];
  permissionMode: WorkflowDocumentStep["permissionMode"];
}

/** Id → name, for each of the three catalogues a Step points into. */
export interface ExportNames {
  harnessProfile: ReadonlyMap<string, string>;
  mcpServer: ReadonlyMap<string, string>;
  skill: ReadonlyMap<string, string>;
}

/** The names for a list of ids, dropping any the catalogue does not know. */
function namesFor(ids: readonly string[], from: ReadonlyMap<string, string>): string[] {
  return ids.flatMap((id) => {
    const name = from.get(id);
    return name === undefined ? [] : [name];
  });
}

/**
 * A Workflow and its Steps, in pipeline order, as a document.
 *
 * `steps` must already be sorted — the caller has the ranks and the document has none, so the
 * array *is* the order once it is written, and re-sorting here would be a second opinion about it.
 *
 * A branch target that names no Step in the list becomes null, i.e. "the pipeline ends here". That
 * cannot happen for a Workflow read whole out of the database, where `deleteStep` refuses while a
 * branch still points at the Step; it is the honest answer for a partial list, and it keeps the
 * document's one cross-field rule true by construction.
 */
export function workflowToDocument(
  workflow: { name: string; description: string | null },
  steps: readonly ExportableStep[],
  names: ExportNames,
): WorkflowDocument {
  const indexOf = new Map(steps.map((step, index) => [step.id, index]));
  const target = (id: string | null) => (id === null ? null : (indexOf.get(id) ?? null));

  return {
    format: WORKFLOW_DOCUMENT_FORMAT,
    version: WORKFLOW_DOCUMENT_VERSION,
    name: workflow.name,
    description: workflow.description,
    steps: steps.map((step) => ({
      name: step.name,
      // A Step whose profile is missing from the catalogue would be unreadable as a document; the
      // id is the last thing left to say, and it at least round-trips within its own Workspace.
      harnessProfile: names.harnessProfile.get(step.agentProfileId) ?? step.agentProfileId,
      promptTemplate: step.promptTemplate,
      gate: step.gate,
      advanceOn: step.advanceOn,
      onEnter: step.onEnter,
      branch: step.branch
        ? {
            when: step.branch.when,
            thenStep: target(step.branch.thenStepId),
            elseStep: target(step.branch.elseStepId),
          }
        : null,
      mcpServers: namesFor(step.mcpServerIds, names.mcpServer),
      skills: namesFor(step.skillIds, names.skill),
      // Not a name and not an id: one of three fixed postures, so it crosses unchanged.
      permissionMode: step.permissionMode,
    })),
  };
}

/** What the importing Workspace has to offer, name → id. Names are matched case-insensitively. */
export interface ImportCatalog {
  harnessProfiles: readonly { id: string; name: string }[];
  mcpServers: readonly { id: string; name: string }[];
  skills: readonly { id: string; name: string }[];
}

/** One Step, resolved against the importing Workspace — ready to insert, ids and all. */
export interface PlannedStep {
  name: string;
  agentProfileId: string;
  promptTemplate: string;
  gate: WorkflowDocumentStep["gate"];
  advanceOn: WorkflowDocumentStep["advanceOn"];
  onEnter: WorkflowDocumentStep["onEnter"];
  mcpServerIds: string[];
  skillIds: string[];
  permissionMode: WorkflowDocumentStep["permissionMode"];
  /**
   * The branch, still by index: the rows do not exist yet, so there are no ids to point at. The
   * DAL writes the Steps first and re-points the branches once every index has one.
   */
  branch: { when: WorkflowStepCondition; thenStep: number | null; elseStep: number | null } | null;
}

export interface ImportPlan {
  name: string;
  description: string | null;
  steps: PlannedStep[];
  unmatchedHarnessProfiles: string[];
  unmatchedMcpServers: string[];
  unmatchedSkills: string[];
}

/** Case-insensitive name → id, first writer wins so a duplicated name resolves deterministically. */
function lookup(items: readonly { id: string; name: string }[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, item.id);
  }
  return byName;
}

/**
 * A name this Workspace does not already use, from the one that was asked for.
 *
 * Workflow names are unique per Workspace (`workflow_ws_name`), so importing the same document
 * twice — the ordinary way to try a shared pipeline and then keep a variant of it — would
 * otherwise be refused on the second go. Suffixing is what every file manager does with a
 * duplicate, and it is recognisable as such; failing with a constraint violation is not.
 *
 * The counter starts at 2 because the untaken original is the 1.
 */
export function availableWorkflowName(desired: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const base = desired.trim();
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Resolve a document against a Workspace: what to write, and what could not be carried.
 *
 * The two failure modes are deliberately different, and this is the function where that is
 * decided rather than the surface that shows it:
 *
 *  - **A Skill or MCP server with no match is dropped.** It is additive — the Step runs without
 *    it, a little less equipped — and refusing a whole pipeline over one Skill would make a
 *    document only importable into the Workspace it left.
 *  - **A Harness Profile with no match falls back**, to `fallbackProfileId` or to the first
 *    profile in the catalogue. A Step must name a harness, and the alternative to a substitution
 *    is no pipeline at all. The name asked for comes back in `unmatchedHarnessProfiles`, so the
 *    designer can say which Steps to re-point.
 *
 * Returns null when the catalogue has no Harness Profile at all: there is nothing to fall back to,
 * and that is the one shape of this that cannot be repaired by editing the result afterwards.
 */
export function planWorkflowImport(
  document: WorkflowDocument,
  catalog: ImportCatalog,
  options: {
    name?: string | undefined;
    fallbackProfileId?: string | undefined;
    taken?: Iterable<string>;
  } = {},
): ImportPlan | null {
  const profiles = lookup(catalog.harnessProfiles);
  const fallback =
    options.fallbackProfileId ??
    [...catalog.harnessProfiles].sort((a, b) => a.name.localeCompare(b.name))[0]?.id;
  if (fallback === undefined) return null;

  const servers = lookup(catalog.mcpServers);
  const skills = lookup(catalog.skills);
  const unmatchedHarnessProfiles = new Set<string>();
  const unmatchedMcpServers = new Set<string>();
  const unmatchedSkills = new Set<string>();

  const resolveTools = (
    names: readonly string[],
    from: Map<string, string>,
    missing: Set<string>,
  ) => {
    const ids: string[] = [];
    for (const name of names) {
      const id = from.get(name.trim().toLowerCase());
      if (id === undefined) missing.add(name);
      else if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  const steps = document.steps.map((step): PlannedStep => {
    const matched = profiles.get(step.harnessProfile.trim().toLowerCase());
    if (matched === undefined) unmatchedHarnessProfiles.add(step.harnessProfile);
    return {
      name: step.name,
      agentProfileId: matched ?? fallback,
      promptTemplate: step.promptTemplate,
      gate: step.gate,
      advanceOn: step.advanceOn,
      onEnter: step.onEnter,
      mcpServerIds: resolveTools(step.mcpServers, servers, unmatchedMcpServers),
      skillIds: resolveTools(step.skills, skills, unmatchedSkills),
      permissionMode: step.permissionMode,
      branch: step.branch
        ? { when: step.branch.when, thenStep: step.branch.thenStep, elseStep: step.branch.elseStep }
        : null,
    };
  });

  return {
    name: availableWorkflowName(options.name?.trim() || document.name, options.taken ?? []),
    description: document.description,
    steps,
    unmatchedHarnessProfiles: [...unmatchedHarnessProfiles],
    unmatchedMcpServers: [...unmatchedMcpServers],
    unmatchedSkills: [...unmatchedSkills],
  };
}

/** A file name for an exported document — the pipeline's name, slugged, so a download is findable. */
export function workflowDocumentFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "workflow"}.workflow.json`;
}
