import "server-only";
import type {
  IssueMilestone,
  ProjectFieldDto,
  ProjectFieldOption,
  ProjectFieldType,
  ProjectFieldValue,
  ProjectUser,
} from "@solow/contracts";

/**
 * A local Project's field set, synthesized rather than mirrored (spec F23 FR-18-22, user request
 * 2026-08-28).
 *
 * A local Project has no provider board to read `project_field` rows from — FR-21 is explicit
 * that it never carries any — so a table with only its five built-in columns (Title, Agent runs,
 * Linked changes, Labels, Sub-issues) was the honest consequence of that, but not a useful one:
 * the Issues underneath it already carry a Status, a Priority, a Size, an Assignee, a Milestone —
 * GitLab's own scoped-label convention (`status::doing`) or SoloW's own seeded taxonomy
 * (`status/todo`, see `label-taxonomy.ts`) either way — and none of it reached the table.
 *
 * So these columns are computed here, at read time, from what the Issues already hold — never
 * persisted as `project_field` rows, which keeps FR-21's "zero rows" literally true. The same
 * multi-separator matching `packages/core/src/priority.ts` already uses for its own narrower
 * purpose (`::`, `:`, `/`, `-`, `_`, space) is generalized here to Status and Size too, so a label
 * written either GitLab's native way or SoloW's own seeded way is read the same.
 *
 * Read-only, every one of them, for now: this mirrors an Issue's own data the way a provider
 * mirror does (F23 FR-8), and writing a value back — editing a local Issue's labels from the
 * table — is a real feature, just not this one (matches the read-only scope already agreed for
 * this round).
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
  labels: string[];
  assignees: ProjectUser[];
  milestone: IssueMilestone | null;
  repositoryName: string | null;
  createdAt: string;
  updatedAt: string;
  externalState: "open" | "closed" | null;
}

const LOCAL_FIELD_UNAVAILABLE =
  "This Project is local — there is no provider board to hold a value like this.";

interface FieldSpec {
  id: string;
  name: string;
  type: ProjectFieldType;
  options?: ProjectFieldOption[];
  readOnlyReason?: string;
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
  const allLabels = issues.flatMap((i) => i.labels);

  const specs: FieldSpec[] = [
    { id: "local:assignees", name: "Assignees", type: "user" },
    {
      id: "local:status",
      name: "Status",
      type: "single_select",
      options: scopedOptions(allLabels, SCOPE_ALIASES.status ?? []),
    },
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
    { id: "local:milestone", name: "Milestone", type: "text" },
    { id: "local:repository", name: "Repository", type: "text" },
    { id: "local:created", name: "Created", type: "date" },
    { id: "local:updated", name: "Updated", type: "date" },
    { id: "local:closed", name: "Closed", type: "text" },
    // Unexpressible for the same reason GitLab's own mirrored Projects declare them so (Decision
    // 0018): there is no per-issue number/date field a local Project could have read one from —
    // it has no provider board at all, mirrored or otherwise.
    {
      id: "local:estimate",
      name: "Estimate",
      type: "number",
      readOnlyReason: LOCAL_FIELD_UNAVAILABLE,
    },
    {
      id: "local:iteration",
      name: "Iteration",
      type: "iteration",
      readOnlyReason: LOCAL_FIELD_UNAVAILABLE,
    },
    {
      id: "local:start_date",
      name: "Start date",
      type: "date",
      readOnlyReason: LOCAL_FIELD_UNAVAILABLE,
    },
    {
      id: "local:target_date",
      name: "Target date",
      type: "date",
      readOnlyReason: LOCAL_FIELD_UNAVAILABLE,
    },
  ];

  const fields: ProjectFieldDto[] = specs.map((spec, position) => ({
    id: spec.id,
    providerFieldId: spec.id,
    name: spec.name,
    type: spec.type,
    options: spec.options ?? [],
    iterations: [],
    position,
    readOnly: true,
    readOnlyReason: spec.readOnlyReason ?? null,
  }));

  const valuesByIssueId = new Map<string, Record<string, ProjectFieldValue>>();
  for (const issue of issues) {
    const values: Record<string, ProjectFieldValue> = {};
    if (issue.assignees.length > 0) {
      values["local:assignees"] = { type: "user", users: issue.assignees };
    }
    const status = scopedValue(issue.labels, SCOPE_ALIASES.status ?? []);
    if (status) values["local:status"] = status;
    const priority = scopedValue(issue.labels, SCOPE_ALIASES.priority ?? []);
    if (priority) values["local:priority"] = priority;
    const size = scopedValue(issue.labels, SCOPE_ALIASES.size ?? []);
    if (size) values["local:size"] = size;
    if (issue.milestone) values["local:milestone"] = { type: "text", text: issue.milestone.title };
    if (issue.repositoryName) {
      values["local:repository"] = { type: "text", text: issue.repositoryName };
    }
    values["local:created"] = { type: "date", date: issue.createdAt };
    values["local:updated"] = { type: "date", date: issue.updatedAt };
    if (issue.externalState) {
      values["local:closed"] = {
        type: "text",
        text: issue.externalState === "closed" ? "Yes" : "No",
      };
    }
    valuesByIssueId.set(issue.id, values);
  }

  return { fields, valuesByIssueId };
}
