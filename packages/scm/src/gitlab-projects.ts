import type { ProjectFieldOption, ProjectFieldType, ProjectFieldValue } from "@solow/contracts";
import { scmFetch, scmSend } from "./http.js";
import type {
  ExternalProject,
  ExternalProjectField,
  ExternalProjectItem,
  ExternalProjectItemIssue,
  ExternalProjectItemPage,
  ExternalProjectValue,
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
 * Turn a repository's scoped labels into single-select fields.
 *
 * `status::in-progress` and `status::done` are two options of one field, not two labels. Grouping
 * them is the entire trick that makes GitLab look like a project — and the reason the prefix has
 * to be configuration: the grouping key *is* the field.
 */
export function fieldsFromLabels(
  labels: GitlabLabel[],
  mapping: GitlabFieldMapping,
): ExternalProjectField[] {
  const fields: ExternalProjectField[] = [];
  let position = 0;

  for (const [fieldName, prefix] of Object.entries(mapping.scopedLabels)) {
    const marker = `${prefix}::`;
    const options: ProjectFieldOption[] = labels
      .filter((l) => l.name.toLowerCase().startsWith(marker.toLowerCase()))
      .map((l) => ({
        id: l.name,
        name: l.name.slice(marker.length),
        ...(l.color ? { color: l.color } : {}),
      }));
    fields.push({
      externalId: `label:${prefix}`,
      name: fieldName,
      type: "single_select",
      options,
      iterations: [],
      position: position++,
      readOnly: false,
      readOnlyReason: null,
    });
  }

  // The fields this instance cannot hold are still listed, read-only, with the reason — because
  // a column set that hides what it cannot do is a column set that lies about the project
  // (F23 FR-5, #124 AC-3, AC-6).
  const unavailable: Array<[string, ProjectFieldType, string]> = [];
  if (!mapping.hasWeights) {
    unavailable.push(["Estimate", "number", GITLAB_FIELD_SUPPORT.cannot.number ?? ""]);
  }
  if (!mapping.hasIterations) {
    unavailable.push(["Iteration", "iteration", GITLAB_FIELD_SUPPORT.cannot.iteration ?? ""]);
  }
  unavailable.push(["Start date", "date", GITLAB_FIELD_SUPPORT.cannot.date ?? ""]);
  unavailable.push(["Target date", "date", GITLAB_FIELD_SUPPORT.cannot.date ?? ""]);

  for (const [name, type, reason] of unavailable) {
    fields.push({
      externalId: `unavailable:${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      type,
      options: [],
      iterations: [],
      position: position++,
      readOnly: true,
      readOnlyReason: reason,
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
  for (const prefix of Object.values(mapping.scopedLabels)) {
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
 * The scoped-label structure a GitLab project needs to behave like a project.
 *
 * A template, not a schema: a team is free to use another vocabulary, and one already using
 * `Status::Doing` keeps it — this only ever *adds* what is absent (see `provisionProjectStructure`).
 * The values are the ones GitLab teams converge on, and the order is the order they read in.
 */
export const GITLAB_LABEL_TEMPLATE: Record<string, string[]> = {
  status: ["todo", "doing", "done"],
  priority: ["high", "medium", "low"],
  size: ["XS", "S", "M", "L", "XL"],
};

/** A muted palette, so a freshly provisioned board is not a wall of primary colours. */
const TEMPLATE_COLOR: Record<string, string> = {
  status: "#6b7280",
  priority: "#b45309",
  size: "#4338ca",
};

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
    for (const [prefix, values] of Object.entries(GITLAB_LABEL_TEMPLATE)) {
      for (const value of values) {
        const name = `${prefix}::${value}`;
        if (already.has(name.toLowerCase())) {
          existing.push(name);
          continue;
        }
        const url = new URL(root);
        url.searchParams.set("name", name);
        url.searchParams.set("color", TEMPLATE_COLOR[prefix] ?? "#6b7280");
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
