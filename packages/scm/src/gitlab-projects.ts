import type { ProjectFieldOption, ProjectFieldType, ProjectFieldValue } from "@solow/contracts";
import { scmFetch, scmSend } from "./http.js";
import { DEFAULT_LABEL_TAXONOMY } from "./label-taxonomy.js";
import type {
  ExternalProject,
  ExternalProjectField,
  ExternalProjectItem,
  ExternalProjectItemIssue,
  ExternalProjectItemPage,
  ExternalProjectValue,
  LabelSeed,
  ProjectFieldWrite,
  ProjectStructureProvisioned,
  ScmCredential,
} from "./types.js";

/**
 * GitLab planning (spec F23, Decision 0018, issue #124).
 *
 * **This is the driver that proves the abstraction, and the one most likely to be quietly
 * skipped.** GitLab has no Projects. What it has is what teams already use in its place: scoped
 * labels — `status::in-progress`, `priority::high`, `size::XL` — plus, on paid tiers, iterations
 * and weights.
 *
 * So a "project" here is a GitLab project plus a field mapping, and the mapping is configuration
 * rather than a constant: a team writing `Status::Doing` is not misconfigured, it is a team
 * (F23 FR-12).
 *
 * The rule that keeps this honest: **a scoped label is a single-select and nothing else.** Number
 * and date fields are declared unexpressible with a reason, and the table renders them read-only
 * (F23 FR-5). Faking a number inside a label name is how a planning tool starts lying about
 * arithmetic.
 */

const PROVIDER = "gitlab";

/** What a scoped label can carry, and what it cannot — the answer the manifest publishes. */
export const GITLAB_FIELD_SUPPORT = {
  expresses: ["single_select", "user", "text", "url"] as ProjectFieldType[],
  cannot: {
    number: "GitLab has no per-issue number field; weights are a paid tier",
    date: "GitLab has no per-issue date field; milestone dates are per milestone",
    iteration: "GitLab iterations are a paid tier",
  } as Record<string, string>,
};

/**
 * How a field maps onto GitLab, per project.
 *
 * Discovered rather than assumed: the connect flow reads the labels that exist and offers a
 * mapping, which the Owner confirms or changes (#124 AC-2).
 */
export interface GitlabFieldMapping {
  /** Field name as the table shows it → the scoped-label prefix that carries it. */
  scopedLabels: Record<string, string>;
  /** Whether this instance answers for iterations and weights (a paid tier does). */
  hasIterations: boolean;
  hasWeights: boolean;
}

export const DEFAULT_GITLAB_MAPPING: GitlabFieldMapping = {
  scopedLabels: { Status: "status", Priority: "priority", Size: "size" },
  hasIterations: false,
  hasWeights: false,
};

interface GitlabLabel {
  id: number;
  name: string;
  color: string | null;
}

/**
 * F23 FR-1's three single-selects, in canonical order. A fixed list rather than
 * `Object.keys(mapping.scopedLabels)` — the entire point of this change is that the column set no
 * longer depends on what the mapping happens to contain. FR-12 promises the Owner can rename the
 * scoped-label prefix underneath a column; it never promised they could make the column
 * disappear by omitting it from a hand-edited mapping (#124 AC-2, F23a Part 2).
 */
const CANONICAL_SINGLE_SELECTS = ["Status", "Priority", "Size"] as const;

/**
 * The scoped-label prefix that carries `fieldName`: the Owner's mapping when it names one, else
 * the field's own lowercase name — the same fallback `DEFAULT_GITLAB_MAPPING` already encodes.
 * This is what lets `fieldsFromLabels` guarantee Status/Priority/Size exist even when a custom
 * `GitlabFieldMapping` forgot one of them, without ever inventing a prefix the mapping didn't ask
 * for once it *does* name one.
 */
function canonicalPrefix(mapping: GitlabFieldMapping, fieldName: string): string {
  return mapping.scopedLabels[fieldName] ?? fieldName.toLowerCase();
}

function singleSelectField(
  name: string,
  prefix: string,
  labels: GitlabLabel[],
  position: number,
): ExternalProjectField {
  const marker = `${prefix}::`;
  const options: ProjectFieldOption[] = labels
    .filter((l) => l.name.toLowerCase().startsWith(marker.toLowerCase()))
    .map((l) => ({
      id: l.name,
      name: l.name.slice(marker.length),
      ...(l.color ? { color: l.color } : {}),
    }));
  return {
    externalId: `label:${prefix}`,
    name,
    type: "single_select",
    options,
    iterations: [],
    position,
    readOnly: false,
    readOnlyReason: null,
  };
}

/**
 * Turn a repository's scoped labels into the seven F23 FR-1 columns, always, in canonical order —
 * Status, Priority, Size, Estimate, Iteration, Start date, Target date — so a GitLab Project is
 * the same shape as a GitHub one on the day it is connected, before a single scoped label exists
 * (F23a Part 2, #124 AC-3).
 *
 * `status::in-progress` and `status::done` are two options of one field, not two labels. Grouping
 * them is the entire trick that makes GitLab look like a project — and the reason the prefix has
 * to be configuration: the grouping key *is* the field. An empty options array is not a missing
 * field, just a fresh one: the column still renders, waiting for its first scoped label.
 */
export function fieldsFromLabels(
  labels: GitlabLabel[],
  mapping: GitlabFieldMapping,
): ExternalProjectField[] {
  const fields: ExternalProjectField[] = [];
  let position = 0;

  for (const fieldName of CANONICAL_SINGLE_SELECTS) {
    fields.push(
      singleSelectField(fieldName, canonicalPrefix(mapping, fieldName), labels, position++),
    );
  }

  // A mapping may still name further scoped-label fields beyond the canonical three — FR-12 puts
  // no ceiling on the Owner's own vocabulary. They get a column too, appended after the canonical
  // set so "the first seven columns are always these seven" stays true regardless.
  for (const [fieldName, prefix] of Object.entries(mapping.scopedLabels)) {
    if ((CANONICAL_SINGLE_SELECTS as readonly string[]).includes(fieldName)) continue;
    fields.push(singleSelectField(fieldName, prefix, labels, position++));
  }

  // Estimate, Iteration, Start date, Target date — always present, in this order, because F23
  // FR-1 promises the same seven columns as GitHub regardless of what this instance can actually
  // hold (Decision 0018). Whether one is editable is a tier fact, not a presence fact (F23 FR-5):
  // Estimate/Iteration flip to editable on a tier that provides weights/iterations, while the two
  // dates stay read-only on every tier — GitLab has no per-issue date field at all. `externalId`
  // keeps its `unavailable:` scheme even once a field turns editable, so a stored view/column
  // preference built against the old always-read-only shape keeps pointing at the same column.
  const typed: Array<[name: string, type: ProjectFieldType, expressible: boolean, reason: string]> =
    [
      ["Estimate", "number", mapping.hasWeights, GITLAB_FIELD_SUPPORT.cannot.number ?? ""],
      [
        "Iteration",
        "iteration",
        mapping.hasIterations,
        GITLAB_FIELD_SUPPORT.cannot.iteration ?? "",
      ],
      ["Start date", "date", false, GITLAB_FIELD_SUPPORT.cannot.date ?? ""],
      ["Target date", "date", false, GITLAB_FIELD_SUPPORT.cannot.date ?? ""],
    ];
  for (const [name, type, expressible, reason] of typed) {
    fields.push({
      externalId: `unavailable:${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      type,
      options: [],
      iterations: [],
      position: position++,
      readOnly: !expressible,
      readOnlyReason: expressible ? null : reason,
    });
  }
  return fields;
}

interface GitlabIssue {
  id: number;
  iid: number;
  title: string;
  labels: string[];
  assignees?: Array<{ username: string; name?: string | null; avatar_url?: string | null }>;
  updated_at?: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  /** `{ full: "group/project#12" }` — the only place the issue names its own project's path. */
  references?: { full?: string };
}

/**
 * The issue carried with its row, so a project can be mirrored without its repository having
 * been connected first.
 *
 * The path comes from `references.full` ("group/project#12") because that is the only field in
 * which GitLab states the issue's own project path; the listing is addressed by numeric id, and
 * deriving a path from `web_url` would be reconstructing what the provider already says. When
 * the reference is missing the issue is **omitted rather than half-built** — absent means "could
 * not say", and the mirror then waits for the repository sync exactly as it used to.
 */
function carriedIssue(issue: GitlabIssue): ExternalProjectItemIssue | undefined {
  const path = issue.references?.full?.split("#")[0];
  if (!path) return undefined;
  return {
    repositoryFullName: path,
    externalId: String(issue.iid),
    number: issue.iid,
    title: issue.title,
    description: issue.description ?? null,
    // GitLab says "opened", not "open", and everything other than closed is open.
    state: issue.state === "closed" ? "closed" : "open",
    url: issue.web_url ?? "",
    assignees: (issue.assignees ?? []).map((u) => ({
      login: u.username,
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
    })),
    labels: issue.labels,
    ...(issue.updated_at ? { updatedAt: issue.updated_at } : {}),
  };
}

/**
 * Read an issue's labels back as field values.
 *
 * One label per scope is GitLab's own rule, so the first match is the value. A scope with no
 * label on the issue has no value — which is different from an empty one, and the table renders
 * an empty cell rather than a chosen-but-blank option.
 */
export function valuesFromIssue(
  issue: GitlabIssue,
  mapping: GitlabFieldMapping,
): ExternalProjectValue[] {
  const values: ExternalProjectValue[] = [];
  // The same prefixes `fieldsFromLabels` resolves for the columns it always shows — the
  // canonical three (falling back the same way when the mapping omits one) plus whatever else
  // the mapping names — so a column that always exists always has somewhere to read its value
  // from. A `Set` because the canonical fallback and an explicit mapping entry can name the same
  // prefix, and a value should not be reported twice for one field.
  const prefixes = new Set<string>(Object.values(mapping.scopedLabels));
  for (const fieldName of CANONICAL_SINGLE_SELECTS) {
    prefixes.add(canonicalPrefix(mapping, fieldName));
  }
  for (const prefix of prefixes) {
    const marker = `${prefix}::`;
    const found = issue.labels.find((l) => l.toLowerCase().startsWith(marker.toLowerCase()));
    values.push({
      fieldExternalId: `label:${prefix}`,
      value: found
        ? ({ type: "single_select", optionId: found } satisfies ProjectFieldValue)
        : null,
    });
  }
  if (issue.assignees) {
    values.push({
      fieldExternalId: "assignees",
      value: {
        type: "user",
        users: issue.assignees.map((a) => ({
          login: a.username,
          name: a.name ?? null,
          avatarUrl: a.avatar_url ?? null,
        })),
      },
    });
  }
  return values;
}

/**
 * Which of `DEFAULT_LABEL_TAXONOMY`'s families (`label-taxonomy.ts`) seed a Project single-select,
 * and which field they seed it for.
 *
 * The taxonomy is reused rather than duplicated — one place owns "what a fresh status/priority/
 * size vocabulary looks like" for every provider — but it is not copied verbatim, because it
 * wasn't written for GitLab's scoped-label syntax: its separator is `/` (`status/todo`, a plain
 * label, the shape `createLabels`/`labelWrites` seeds on GitHub) where a GitLab scoped label needs
 * `::` (`status::todo`), and its priority family is spelled `prio` while the field it seeds is
 * `Priority`, mapped through whatever prefix this instance's `GitlabFieldMapping` actually uses
 * for it (FR-12) rather than the taxonomy's own word for it. `gitlabLabelSeeds` below does that
 * translation once. `type/*` and `area/*` are not Project columns — GitHub Projects has no such
 * fields either — so they are left alone here and stay `createLabels`'s job.
 */
const TAXONOMY_FAMILY_TO_FIELD: Record<string, string> = {
  status: "Status",
  prio: "Priority",
  size: "Size",
};

/**
 * The starter scoped-label seeds a fresh GitLab project is provisioned with: one per
 * `DEFAULT_LABEL_TAXONOMY` value whose family maps onto a Project single-select, translated into
 * this mapping's own `prefix::value` spelling.
 *
 * A template, not a schema: a team already using `Status::Doing` keeps it — this only ever *adds*
 * what is absent (see `provisionProjectStructure`). Exported so this file's own tests can compute
 * "what would a fresh project be seeded with" without re-deriving the translation.
 */
export function gitlabLabelSeeds(mapping: GitlabFieldMapping): LabelSeed[] {
  const seeds: LabelSeed[] = [];
  for (const seed of DEFAULT_LABEL_TAXONOMY) {
    const slash = seed.name.indexOf("/");
    const family = seed.name.slice(0, slash);
    const fieldName = TAXONOMY_FAMILY_TO_FIELD[family];
    if (!fieldName) continue;
    const value = seed.name.slice(slash + 1);
    seeds.push({ name: `${canonicalPrefix(mapping, fieldName)}::${value}`, color: seed.color });
  }
  return seeds;
}

export class GitlabProjects {
  constructor(private readonly mapping: GitlabFieldMapping = DEFAULT_GITLAB_MAPPING) {}

  private api(credential: ScmCredential): string {
    return `${credential.baseUrl ?? "https://gitlab.com"}/api/v4`;
  }

  private headers(credential: ScmCredential): Record<string, string> {
    return { "private-token": credential.token };
  }

  /**
   * A GitLab "project" for planning purposes is a GitLab project.
   *
   * There is no provider object to mirror — the project *is* the mapping (Decision 0018), which
   * is why this lists repositories rather than something called a project.
   */
  /**
   * Create the scoped labels a GitLab project needs to stand in for a project's fields.
   *
   * GitLab has no project object to import, so this *is* the import's setup step: without
   * `status::*` there is no Status column, because a scoped label group is the column
   * (Decision 0018).
   *
   * **Additive only, and that is not negotiable.** A label already on the repository is left
   * exactly as it is — its colour, its description, its meaning to the team — and only reported.
   * Creating structure without asking is one thing; overwriting a label somebody else defined is
   * another, and a scoped label drives their boards and filters, not just this table.
   *
   * Idempotent: running it twice creates nothing the second time, so a re-import is safe.
   */
  async provisionProjectStructure(
    credential: ScmCredential,
    projectExternalId: string,
  ): Promise<ProjectStructureProvisioned> {
    const root = `${this.api(credential)}/projects/${encodeURIComponent(projectExternalId)}/labels`;
    const present = (await scmFetch(
      PROVIDER,
      `${root}?per_page=100`,
      this.headers(credential),
    )) as GitlabLabel[];
    const already = new Set(present.map((l) => l.name.toLowerCase()));

    const created: string[] = [];
    const existing: string[] = [];
    // `this.mapping`, not a hardcoded prefix: a workspace that renamed Priority's prefix in its
    // own `GitlabFieldMapping` gets that prefix seeded, not a stray `priority::*` label the Owner
    // never configured.
    for (const { name, color } of gitlabLabelSeeds(this.mapping)) {
      if (already.has(name.toLowerCase())) {
        existing.push(name);
        continue;
      }
      const url = new URL(root);
      url.searchParams.set("name", name);
      url.searchParams.set("color", color);
      /*
       * POST, not GET — the same class of bug `writeProjectFieldValue` documents below.
       *
       * `scmFetch` issues a GET. GitLab answers a GET on `/labels` with the existing label
       * list, ignoring `name`/`color` entirely: 200, a plausible array, and no label created.
       * `already` was then computed correctly on the *next* run, so this looked idempotent —
       * every run just re-attempted the same creation and silently did nothing, forever. The
       * fixture test never caught it because it answers any verb with the same canned body and
       * never asserted which one arrived.
       */
      await scmSend(PROVIDER, url.toString(), this.headers(credential), "POST");
      // One at a time, sequentially: GitLab rate-limits bursty writes from one token, and a
      // half-created label set is easier to reason about than a half-failed parallel batch.
      created.push(name);
    }
    return { created, existing };
  }

  async listProjects(credential: ScmCredential): Promise<ExternalProject[]> {
    const raw = (await scmFetch(
      PROVIDER,
      `${this.api(credential)}/projects?membership=true&per_page=100`,
      this.headers(credential),
    )) as Array<{ id: number; name_with_namespace: string; web_url: string }>;
    return raw.map((p) => ({
      externalId: String(p.id),
      title: p.name_with_namespace,
      url: p.web_url,
    }));
  }

  async readProjectFields(
    credential: ScmCredential,
    projectExternalId: string,
  ): Promise<ExternalProjectField[]> {
    const labels = (await scmFetch(
      PROVIDER,
      `${this.api(credential)}/projects/${encodeURIComponent(projectExternalId)}/labels?per_page=100`,
      this.headers(credential),
    )) as GitlabLabel[];
    return fieldsFromLabels(labels, this.mapping);
  }

  async readProjectItems(
    credential: ScmCredential,
    projectExternalId: string,
    cursor: string | null,
  ): Promise<ExternalProjectItemPage> {
    // Keyset pagination on GitLab's own page number, kept opaque to the caller: the cursor is a
    // driver's private business, and the DAL stores it without reading it (#121 AC-5).
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    const raw = (await scmFetch(
      PROVIDER,
      `${this.api(credential)}/projects/${encodeURIComponent(projectExternalId)}/issues?per_page=50&page=${page}`,
      this.headers(credential),
    )) as GitlabIssue[];

    const items: ExternalProjectItem[] = raw.map((issue, index) => {
      const carried = carriedIssue(issue);
      return {
        externalId: String(issue.id),
        // `iid`, not `id` — the same id space `listIssues` persists as `issue.external_id`.
        // GitLab's `id` is instance-wide and its `iid` restarts at 1 per project; the issues
        // capability writes the `iid`, so reporting the `id` here made every row unresolvable.
        issueExternalId: String(issue.iid),
        position: (page - 1) * 50 + index,
        archivedAt: null,
        values: valuesFromIssue(issue, this.mapping),
        ...(carried ? { issue: carried } : {}),
      };
    });

    // GitLab has no draft cards and lists no merge requests here: a project's issues endpoint
    // returns issues. Reporting zero is a fact about this provider, not a gap in the driver.
    return {
      items,
      nextCursor: raw.length === 50 ? String(page + 1) : null,
      drafts: 0,
      pullRequests: 0,
    };
  }

  /**
   * Write a single-select by moving the issue from one scoped label to another.
   *
   * GitLab enforces one label per scope, so this is two operations — and the order matters. Using
   * `add_labels` **and** `remove_labels` in one request lets GitLab apply them together; doing it
   * as two requests would leave a window where the issue carries neither, which is a status that
   * momentarily reads as unset to everything watching (#124 AC-4).
   */
  async writeProjectFieldValue(
    credential: ScmCredential,
    write: ProjectFieldWrite,
  ): Promise<ExternalProjectValue> {
    const prefix = write.fieldExternalId.startsWith("label:")
      ? write.fieldExternalId.slice("label:".length)
      : null;
    if (!prefix) {
      // A field this driver declared unexpressible. The table should not have offered the edit;
      // refusing here is the second line, not the first.
      return { fieldExternalId: write.fieldExternalId, value: null };
    }

    const marker = `${prefix}::`;
    const next = write.value?.type === "single_select" ? write.value.optionId : null;
    const url = new URL(
      `${this.api(credential)}/projects/${encodeURIComponent(write.projectExternalId)}/issues/${encodeURIComponent(write.itemExternalId)}`,
    );
    if (next) url.searchParams.set("add_labels", next);
    // Remove every other label of this scope in the same request, so the issue is never left
    // with none of them.
    url.searchParams.set("remove_labels_scope", marker);

    /*
     * PUT, not GET — and this is not a detail.
     *
     * `scmFetch` issues a GET. GitLab answers a GET on this path with the issue, ignoring
     * `add_labels` entirely: 200, a plausible issue object, and nothing changed. The value was
     * then read back out of that unchanged answer, so a write that never happened reported the
     * old value as though it were the new one. The test asserted the query string and never the
     * verb, which is why it passed.
     */
    const updated = (await scmSend(PROVIDER, url.toString(), this.headers(credential), "PUT")) as
      | GitlabIssue
      | undefined;

    // What GitLab now holds, read back from its answer — never the value that was sent.
    const stored = updated?.labels?.find((l) => l.toLowerCase().startsWith(marker.toLowerCase()));
    return {
      fieldExternalId: write.fieldExternalId,
      value: stored ? { type: "single_select", optionId: stored } : null,
    };
  }
}
