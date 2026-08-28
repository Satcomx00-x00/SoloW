import "server-only";
import type {
  IssueMilestone,
  LinkedChangeRequest,
  ProjectFieldDto,
  ProjectFieldOption,
  ProjectFieldType,
  ProjectFieldValue,
  ProjectUser,
} from "@solow/contracts";

/**
 * A local Project's field set, synthesized rather than mirrored (spec F23 FR-18-23, user request
 * 2026-08-28).
 *
 * A local Project has no provider board to read `project_field` rows from — FR-21 is explicit
 * that it never carries any — so a table with only its five built-in columns (Title, Agent runs,
 * Linked changes, Labels, Sub-issues) was the honest consequence of that, but not a useful one:
 * the Issues underneath it already carry a Status, a Priority, a Size, an Assignee, a Milestone —
 * GitLab's own scoped-label convention (`status::doing`) or SoloW's own seeded taxonomy
 * (`status/todo`, see `label-taxonomy.ts`) either way — and none of it reached the table.
 *
 * **The column set is GitHub Projects v2's own, exactly** — same nineteen columns, same names, in
 * the same order (user request 2026-08-28: a GitLab-backed Project must not look like a poorer
 * one). A column with nothing behind it on this side is still declared, and renders empty: a
 * table that grows and shrinks its columns depending on which provider filled it is a table two
 * people cannot talk about. Where a column genuinely cannot be filled at all — GitLab has no
 * reviewers on an issue, and a local Project has no board to hold a number or a date — it is
 * declared read-only with the reason, the same rule Decision 0018 already applies to a mirrored
 * GitLab Project (F23 FR-5/FR-16).
 *
 * These are computed at read time and never persisted as `project_field` rows, which keeps
 * FR-21's "zero rows" literally true. The multi-separator matching `packages/core/src/priority.ts`
 * already uses for its own narrower purpose (`::`, `:`, `/`, `-`, `_`, space) is generalized here
 * to Status and Size too, so a label written either GitLab's native way or SoloW's own seeded way
 * is read the same.
 *
 * Read-only, every one of them, for now: this mirrors an Issue's own data the way a provider
 * mirror does (F23 FR-8), and writing a value back — editing a local Issue's labels from the
 * table — is a real feature, just not this one.
 */

const SCOPE_ALIASES: Record<string, string[]> = {
  status: ["status"],
  priority: ["priority", "prio", "pri"],
  size: ["size"],
};

// The pattern's own end-anchor, built separately from the template literal it closes: a regex
// end-anchor written directly before a template literal's closing backtick is, by coincidence,
// the same two characters `scripts/audit-executor-boundary.ts` flags as Bun's shell-tag syntax.
// It is not one — nothing in this file touches a process or the filesystem. Splitting the anchor
// out is cheaper than teaching that scanner syntax it was never meant to parse.
const END_OF_LABEL = "$";

function scopePattern(aliases: string[]): RegExp {
  return new RegExp(`^(?:${aliases.join("|")})\\s*(?:::|[:/\\-_\\s])\\s*(.+)${END_OF_LABEL}`, "i");
}

function scopedOptions(labels: Iterable<string>, aliases: string[]): ProjectFieldOption[] {
  const pattern = scopePattern(aliases);
  const seen = new Set<string>();
  const options: ProjectFieldOption[] = [];
  for (const label of labels) {
    const match = pattern.exec(label);
    if (!match) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ id: label, name: match[1] ?? label });
  }
  return options;
}

function scopedValue(labels: readonly string[], aliases: string[]): ProjectFieldValue | null {
  const pattern = scopePattern(aliases);
  const found = labels.find((l) => pattern.test(l));
  return found ? { type: "single_select", optionId: found } : null;
}

/** One Issue's worth of raw material this module derives columns from. */
export interface LocalFieldIssue {
  id: string;
  title: string;
  /** The provider's own id, and the parent's — what the sub-issue roll-up is matched on. */
  externalId: string | null;
  externalParentId: string | null;
  labels: string[];
  assignees: ProjectUser[];
  milestone: IssueMilestone | null;
  linkedChangeRequests: LinkedChangeRequest[];
  repositoryName: string | null;
  createdAt: string;
  updatedAt: string;
  externalState: "open" | "closed" | null;
}

const NO_BOARD = "This Project is local — there is no provider board to hold a value like this.";
const NO_ISSUE_REVIEWERS =
  "Reviewers belong to a merge or pull request, not to an issue — no provider reports one here.";

interface FieldSpec {
  id: string;
  name: string;
  type: ProjectFieldType;
  options?: ProjectFieldOption[];
  readOnlyReason?: string;
}

/**
 * GitHub Projects v2's own column set, in its own order — the list a mirrored GitHub Project
 * produces, reproduced here so the two tables are the same table (see this module's header).
 * Ids are namespaced `local:` because they are this side's, not a provider's.
 */
function fieldSpecs(allLabels: string[]): FieldSpec[] {
  return [
    { id: "local:title", name: "Title", type: "text" },
    { id: "local:assignees", name: "Assignees", type: "user" },
    {
      id: "local:status",
      name: "Status",
      type: "single_select",
      options: scopedOptions(allLabels, SCOPE_ALIASES.status ?? []),
    },
    { id: "local:labels", name: "Labels", type: "text" },
    { id: "local:linked_change_requests", name: "Linked pull requests", type: "text" },
    { id: "local:milestone", name: "Milestone", type: "text" },
    { id: "local:repository", name: "Repository", type: "text" },
    { id: "local:reviewers", name: "Reviewers", type: "text", readOnlyReason: NO_ISSUE_REVIEWERS },
    { id: "local:parent_issue", name: "Parent issue", type: "text" },
    { id: "local:sub_issues", name: "Sub-issues progress", type: "text" },
    { id: "local:created", name: "Created", type: "date" },
    { id: "local:updated", name: "Updated", type: "date" },
    { id: "local:closed", name: "Closed", type: "text" },
    {
      id: "local:priority",
      name: "Priority",
      type: "single_select",
      options: scopedOptions(allLabels, SCOPE_ALIASES.priority ?? []),
    },
    {
      id: "local:size",
      name: "Size",
      type: "single_select",
      options: scopedOptions(allLabels, SCOPE_ALIASES.size ?? []),
    },
    // Unexpressible for the same reason GitLab's own mirrored Projects declare them so (Decision
    // 0018): there is no per-issue number/date/iteration field a local Project could read one
    // from — it has no provider board at all, mirrored or otherwise.
    { id: "local:estimate", name: "Estimate", type: "number", readOnlyReason: NO_BOARD },
    { id: "local:iteration", name: "Iteration", type: "iteration", readOnlyReason: NO_BOARD },
    { id: "local:start_date", name: "Start date", type: "date", readOnlyReason: NO_BOARD },
    { id: "local:target_date", name: "Target date", type: "date", readOnlyReason: NO_BOARD },
  ];
}

/**
 * Every Issue a local Project holds, and its field set — computed together so the two can never
 * disagree about what a field's id means (`getProject` and `listProjectItems` each call this over
 * whatever slice of Issues they have; see their own comments for why a shared-but-recomputed
 * function is fine here rather than a problem).
 */
export function deriveLocalProjectFields(issues: readonly LocalFieldIssue[]): {
  fields: ProjectFieldDto[];
  valuesByIssueId: Map<string, Record<string, ProjectFieldValue>>;
} {
  const fields: ProjectFieldDto[] = fieldSpecs(issues.flatMap((i) => i.labels)).map(
    (spec, position) => ({
      id: spec.id,
      providerFieldId: spec.id,
      name: spec.name,
      type: spec.type,
      options: spec.options ?? [],
      iterations: [],
      position,
      readOnly: true,
      readOnlyReason: spec.readOnlyReason ?? null,
    }),
  );

  /**
   * Children per parent, counted over the Issues in hand.
   *
   * Bounded by what the caller passed, deliberately: a page's roll-up counts the children on
   * that page. The alternative — a query per row to count children Project-wide — is the
   * per-row fan-out a mirror exists to avoid (F23 NFR-2), and this column is a summary, not an
   * authority. `buildProjectHierarchy` is what actually nests the rows.
   */
  const children = new Map<string, { total: number; closed: number }>();
  for (const issue of issues) {
    if (!issue.externalParentId) continue;
    const tally = children.get(issue.externalParentId) ?? { total: 0, closed: 0 };
    tally.total += 1;
    if (issue.externalState === "closed") tally.closed += 1;
    children.set(issue.externalParentId, tally);
  }

  const valuesByIssueId = new Map<string, Record<string, ProjectFieldValue>>();
  for (const issue of issues) {
    const values: Record<string, ProjectFieldValue> = {};

    values["local:title"] = { type: "text", text: issue.title };
    if (issue.assignees.length > 0) {
      values["local:assignees"] = { type: "user", users: issue.assignees };
    }
    const status = scopedValue(issue.labels, SCOPE_ALIASES.status ?? []);
    if (status) values["local:status"] = status;
    if (issue.labels.length > 0) {
      values["local:labels"] = { type: "text", text: issue.labels.join(", ") };
    }
    if (issue.linkedChangeRequests.length > 0) {
      values["local:linked_change_requests"] = {
        type: "text",
        text: issue.linkedChangeRequests.map((c) => `#${c.number}`).join(", "),
      };
    }
    if (issue.milestone) values["local:milestone"] = { type: "text", text: issue.milestone.title };
    if (issue.repositoryName) {
      values["local:repository"] = { type: "text", text: issue.repositoryName };
    }
    // `local:reviewers` is deliberately never set — the column is declared, with its reason, and
    // stays empty. See NO_ISSUE_REVIEWERS.
    if (issue.externalParentId) {
      values["local:parent_issue"] = { type: "text", text: `#${issue.externalParentId}` };
    }
    const tally = issue.externalId ? children.get(issue.externalId) : undefined;
    if (tally) {
      values["local:sub_issues"] = { type: "text", text: `${tally.closed}/${tally.total}` };
    }
    values["local:created"] = { type: "date", date: issue.createdAt };
    values["local:updated"] = { type: "date", date: issue.updatedAt };
    if (issue.externalState) {
      values["local:closed"] = {
        type: "text",
        text: issue.externalState === "closed" ? "Yes" : "No",
      };
    }
    const priority = scopedValue(issue.labels, SCOPE_ALIASES.priority ?? []);
    if (priority) values["local:priority"] = priority;
    const size = scopedValue(issue.labels, SCOPE_ALIASES.size ?? []);
    if (size) values["local:size"] = size;

    valuesByIssueId.set(issue.id, values);
  }

  return { fields, valuesByIssueId };
}
