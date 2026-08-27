import type {
  ProjectFieldOption,
  ProjectFieldType,
  ProjectFieldValue,
  ProjectIteration,
} from "@solow/contracts";
import { scmGraphql } from "./http.js";
import type {
  ExternalProject,
  ExternalProjectField,
  ExternalProjectItem,
  ExternalProjectItemPage,
  ExternalProjectValue,
  ProjectFieldWrite,
  ProjectStructureProvisioned,
  ScmCredential,
} from "./types.js";

/**
 * GitHub Projects v2 (spec F23, Decision 0018, issue #123).
 *
 * The first driver in this package that is not REST: Projects v2 exists only in GitHub's GraphQL
 * API, and there is no v3 equivalent to fall back to.
 *
 * The provider whose model this feature's field types are named after — which is exactly why it
 * must not be the only driver. Projects v2 can express every type in the union, so a contract
 * shaped around it alone would never discover that a provider might not (issue #124 is that
 * discovery).
 */

const PROVIDER = "github";

/** GitHub's own field type names, mapped onto the product's closed union. */
const TYPE_BY_DATA_TYPE: Record<string, ProjectFieldType> = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SINGLE_SELECT: "single_select",
  ITERATION: "iteration",
};

interface GqlFieldCommon {
  id: string;
  name: string;
  dataType: string;
}

interface GqlSingleSelectField extends GqlFieldCommon {
  options?: Array<{ id: string; name: string; color?: string | null }>;
}

interface GqlIterationField extends GqlFieldCommon {
  configuration?: {
    duration: number;
    iterations?: Array<{ id: string; title: string; startDate: string; duration: number }>;
    completedIterations?: Array<{ id: string; title: string; startDate: string; duration: number }>;
  };
}

type GqlField = GqlSingleSelectField & GqlIterationField;

/** A day count from a start date, which is how Projects v2 states an iteration's length. */
function endDateOf(startDate: string, duration: number): string {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  // Inclusive: a 14-day iteration starting on the 1st ends on the 14th, not the 15th.
  start.setUTCDate(start.getUTCDate() + Math.max(duration - 1, 0));
  return start.toISOString().slice(0, 10);
}

function toIterations(field: GqlField): ProjectIteration[] {
  const config = field.configuration;
  if (!config) return [];
  const all = [...(config.iterations ?? []), ...(config.completedIterations ?? [])];
  return all.map((it) => ({
    id: it.id,
    title: it.title,
    startDate: it.startDate,
    endDate: endDateOf(it.startDate, it.duration || config.duration),
  }));
}

function toOptions(field: GqlField): ProjectFieldOption[] {
  return (field.options ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    ...(o.color ? { color: o.color } : {}),
  }));
}

/**
 * Translate one field, including the ones this build has no renderer for.
 *
 * An unknown `dataType` becomes a read-only `text` field named as GitHub names it, rather than
 * being dropped: a column set that silently omits what it cannot render is a column set that
 * lies about what the project holds (F23, States & rules).
 */
export function toExternalField(field: GqlField, position: number): ExternalProjectField {
  const type = TYPE_BY_DATA_TYPE[field.dataType];
  return {
    externalId: field.id,
    name: field.name,
    type: type ?? "text",
    options: type === "single_select" ? toOptions(field) : [],
    iterations: type === "iteration" ? toIterations(field) : [],
    position,
    readOnly: type === undefined,
    readOnlyReason: type === undefined ? `SoloW cannot edit a ${field.dataType} field yet` : null,
  };
}

interface GqlFieldValue {
  field?: { id?: string };
  text?: string;
  number?: number;
  date?: string;
  optionId?: string;
  iterationId?: string;
  users?: { nodes?: Array<{ login: string; name?: string | null; avatarUrl?: string | null }> };
}

/** Read one field value out of the union GraphQL returns, or null when it is a shape we skip. */
export function toExternalValue(raw: GqlFieldValue): ExternalProjectValue | null {
  const fieldExternalId = raw.field?.id;
  if (!fieldExternalId) return null;
  let value: ProjectFieldValue | null = null;
  if (typeof raw.text === "string") value = { type: "text", text: raw.text };
  else if (typeof raw.number === "number") value = { type: "number", number: raw.number };
  else if (typeof raw.date === "string") value = { type: "date", date: raw.date };
  else if (typeof raw.optionId === "string")
    value = { type: "single_select", optionId: raw.optionId };
  else if (typeof raw.iterationId === "string")
    value = { type: "iteration", iterationId: raw.iterationId };
  else if (raw.users?.nodes)
    value = {
      type: "user",
      users: raw.users.nodes.map((u) => ({
        login: u.login,
        name: u.name ?? null,
        avatarUrl: u.avatarUrl ?? null,
      })),
    };
  return { fieldExternalId, value };
}

/**
 * Both places a Projects v2 project can live, in one query.
 *
 * A project belongs to a user *or* to an organization, and a team's project is almost always the
 * second. The previous shape declared an `organization(login:)` field, passed an empty login and
 * read only `viewer` — so an operator on a company account saw an empty picker and no reason for
 * it.
 *
 * One query rather than one per organization: Projects v2 charges points *per query*, so an
 * enumeration that fanned out over twenty orgs would spend the hourly budget answering "which
 * projects exist" — the same N+1 `readProjectItems` already avoids.
 *
 * Reading organizations needs `read:org`. Without it GitHub returns an empty list rather than an
 * error, so the absence is silent — which is why the picker's empty state has to name the scope
 * rather than say "no projects found".
 */
const PROJECTS_QUERY = `
query($after: String) {
  viewer {
    login
    projectsV2(first: 50, after: $after) { nodes { id title url } }
    organizations(first: 50) {
      nodes {
        login
        projectsV2(first: 50) { nodes { id title url } }
      }
    }
  }
}`;

const FIELDS_QUERY = `
query($project: ID!) {
  node(id: $project) { ... on ProjectV2 {
    fields(first: 50) { nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color } }
      ... on ProjectV2IterationField { configuration {
        duration
        iterations { id title startDate duration }
        completedIterations { id title startDate duration }
      } }
    } }
  } }
}`;

/**
 * Items and their values in **one query per page**, not one query per item.
 *
 * Projects v2 costs points per query rather than per call, and an N+1 across a 2000-item project
 * exhausts the hourly budget on its first sync — which would then look like an outage rather than
 * like a design mistake (#123 AC-6).
 */
const ITEMS_QUERY = `
query($project: ID!, $after: String) {
  node(id: $project) { ... on ProjectV2 {
    items(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        isArchived
        content {
          __typename
          ... on Issue {
            id databaseId number title body url state updatedAt
            repository { nameWithOwner }
            assignees(first: 10) { nodes { login name avatarUrl } }
            labels(first: 20) { nodes { name } }
            # The sub-issue parent, asked for here so a project row carries the hierarchy it is
            # about to be drawn in. Without it the table nests nothing: the parent id stays absent
            # on every issue the project scan imported, and "collapse the epic" has no epic.
            parent { databaseId }
            # The pull requests GitHub itself says will close this issue. Asked for here rather
            # than through the REST timeline, which costs one request *per issue*: this rides on
            # the page query that was already being sent.
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
              nodes { id number title url state isDraft mergedAt }
            }
          }
          ... on PullRequest { id databaseId }
        }
        fieldValues(first: 30) { nodes {
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldUserValue { users(first: 10) { nodes { login name avatarUrl } } field { ... on ProjectV2FieldCommon { id } } }
        } }
      }
    }
  } }
}`;

const WRITE_MUTATION = `
mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: $value
  }) {
    projectV2Item { id fieldValues(first: 30) { nodes {
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2FieldCommon { id } } }
    } } }
  }
}`;

/** The mutation input shape, which differs per field type. */
export function toMutationValue(value: ProjectFieldValue | null): Record<string, unknown> {
  if (!value) return { text: "" };
  switch (value.type) {
    case "text":
      return { text: value.text };
    case "number":
      return { number: value.number };
    case "date":
      return { date: value.date };
    case "single_select":
      return { singleSelectOptionId: value.optionId };
    case "iteration":
      return { iterationId: value.iterationId };
    default:
      // `user` and `url` are not writable through this mutation; the caller should not have
      // offered the edit, and refusing loudly beats sending something GitHub will reject.
      return { text: "" };
  }
}

export class GithubProjects {
  /**
   * Nothing to do, and that is the honest answer rather than an omission.
   *
   * A Projects v2 project defines its own fields; there is no structure for SoloW to
   * create. The method exists so the adopt flow can call it unconditionally — a caller that
   * skipped it for GitHub would be branching on a provider's identity to decide behaviour, which
   * is the one thing Decision 0016 forbids.
   */
  async provisionProjectStructure(
    _credential: ScmCredential,
    _projectExternalId: string,
  ): Promise<ProjectStructureProvisioned> {
    return { created: [], existing: [] };
  }

  private graphqlUrl(credential: ScmCredential): string {
    return credential.baseUrl
      ? `${credential.baseUrl}/api/graphql`
      : "https://api.github.com/graphql";
  }

  private headers(credential: ScmCredential): Record<string, string> {
    return {
      authorization: `Bearer ${credential.token}`,
      accept: "application/vnd.github+json",
    };
  }

  async listProjects(credential: ScmCredential): Promise<ExternalProject[]> {
    interface GqlProject {
      id: string;
      title: string;
      url: string;
    }
    const data = await scmGraphql<{
      viewer?: {
        login?: string;
        projectsV2?: { nodes?: GqlProject[] };
        organizations?: { nodes?: Array<{ login: string; projectsV2?: { nodes?: GqlProject[] } }> };
      };
    }>(PROVIDER, this.graphqlUrl(credential), this.headers(credential), PROJECTS_QUERY, {
      after: null,
    });

    const own = (data.viewer?.projectsV2?.nodes ?? []).map((n) => ({
      externalId: n.id,
      title: n.title,
      url: n.url,
      // Whose project this is. Two organizations each with a "Roadmap" are otherwise
      // indistinguishable in a picker, and adopting the wrong one is a silent mistake.
      ownerLogin: data.viewer?.login ?? null,
    }));

    const organisational = (data.viewer?.organizations?.nodes ?? []).flatMap((org) =>
      (org.projectsV2?.nodes ?? []).map((n) => ({
        externalId: n.id,
        title: n.title,
        url: n.url,
        ownerLogin: org.login,
      })),
    );

    return [...own, ...organisational];
  }

  async readProjectFields(
    credential: ScmCredential,
    projectExternalId: string,
  ): Promise<ExternalProjectField[]> {
    const data = await scmGraphql<{ node?: { fields?: { nodes?: GqlField[] } } }>(
      PROVIDER,
      this.graphqlUrl(credential),
      this.headers(credential),
      FIELDS_QUERY,
      { project: projectExternalId },
    );
    const nodes = data.node?.fields?.nodes ?? [];
    return nodes.filter((n) => n?.id).map((n, index) => toExternalField(n, index));
  }

  async readProjectItems(
    credential: ScmCredential,
    projectExternalId: string,
    cursor: string | null,
  ): Promise<ExternalProjectItemPage> {
    const data = await scmGraphql<{
      node?: {
        items?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            id: string;
            isArchived?: boolean;
            content?: {
              __typename?: string;
              id?: string;
              databaseId?: number;
              number?: number;
              title?: string;
              body?: string | null;
              url?: string;
              state?: string;
              updatedAt?: string;
              repository?: { nameWithOwner?: string } | null;
              parent?: { databaseId?: number } | null;
              closedByPullRequestsReferences?: {
                nodes?: Array<{
                  id: string;
                  number: number;
                  title: string;
                  url: string;
                  state: string;
                  isDraft?: boolean;
                  mergedAt?: string | null;
                }>;
              };
              assignees?: {
                nodes?: Array<{ login: string; name?: string | null; avatarUrl?: string | null }>;
              };
              labels?: { nodes?: Array<{ name: string }> };
            } | null;
            fieldValues?: { nodes?: GqlFieldValue[] };
          }>;
        };
      };
    }>(PROVIDER, this.graphqlUrl(credential), this.headers(credential), ITEMS_QUERY, {
      project: projectExternalId,
      after: cursor,
    });

    const page = data.node?.items;
    const items: ExternalProjectItem[] = [];
    let drafts = 0;
    let pullRequests = 0;
    (page?.nodes ?? []).forEach((node, index) => {
      /*
       * `databaseId`, not the GraphQL node id — and this is not a detail.
       *
       * Projects v2 is GraphQL and identifies an issue as `I_kwDO…`; `listIssues` is REST v3 and
       * writes `issue.external_id` as the numeric database id. `refreshProject` joins the two on
       * that column, so reporting the node id here meant *every* project row failed to resolve
       * and was silently counted as "waiting on its issue" — a table permanently empty, with a
       * skipped count that read like a race rather than a mismatch.
       *
       * The two capabilities have to agree on an id space, and the one they agree on is the one
       * already persisted: the issues capability's.
       */
      const content = node.content;
      /*
       * Every row here is an Issue (F23, Out of scope), so the two kinds that are not one have to
       * go — but *counted*, never silently. A table shorter than the same project on GitHub, with
       * nothing to explain the gap, is indistinguishable from a broken import.
       *
       * A pull-request row is its own case rather than "a draft": telling the operator they have
       * three drafts when they have three PRs would be a wrong answer given confidently.
       */
      if (content?.__typename === "PullRequest") {
        pullRequests += 1;
        return;
      }
      const issueExternalId =
        content?.databaseId === undefined ? undefined : String(content.databaseId);
      if (!issueExternalId || content?.__typename !== "Issue") {
        drafts += 1;
        return;
      }

      /*
       * The issue is carried with the row, which is what lets a project span repositories this
       * Workspace has never connected — the ordinary case, and previously the case where every
       * row was skipped for ever.
       *
       * `parentExternalId` is deliberately **not** set: this query does not ask about hierarchy,
       * and absent means "could not say" while null would mean "has no parent" and would un-nest
       * a row that has one.
       */
      /*
       * `parent` has three answers and they mean different things: a number nests the row, an
       * explicit `null` says GitHub was asked and there is no parent, and the key being absent
       * means it could not be read at all. Only the first two may be written — treating absence
       * as "no parent" would un-nest every row on an instance that does not report sub-issues.
       */
      const parent =
        content.parent === undefined
          ? undefined
          : content.parent === null
            ? null
            : content.parent.databaseId === undefined
              ? undefined
              : String(content.parent.databaseId);

      const repositoryFullName = content.repository?.nameWithOwner;
      const issue =
        repositoryFullName && content.number !== undefined && content.title !== undefined
          ? {
              repositoryFullName,
              externalId: issueExternalId,
              number: content.number,
              title: content.title,
              description: content.body ?? null,
              state: content.state === "CLOSED" ? ("closed" as const) : ("open" as const),
              url: content.url ?? "",
              assignees: (content.assignees?.nodes ?? []).map((u) => ({
                login: u.login,
                name: u.name ?? null,
                avatarUrl: u.avatarUrl ?? null,
              })),
              labels: (content.labels?.nodes ?? []).map((l) => l.name),
              /*
               * Absent, never empty, when GitHub did not answer.
               *
               * "This issue has no pull request" and "we could not find out" look identical in a
               * table and only one of them is a fact — the same rule the REST path already keeps
               * (see `linkedChanges`). The key is present here whenever the query returned the
               * connection at all, which is why the check is on the connection and not its nodes.
               */
              ...(content.closedByPullRequestsReferences === undefined
                ? {}
                : {
                    linkedChangeRequests: (content.closedByPullRequestsReferences.nodes ?? []).map(
                      (pr) => ({
                        externalId: pr.id,
                        number: pr.number,
                        title: pr.title,
                        url: pr.url,
                        // GitHub reports MERGED as a state of its own; everything else is open or
                        // closed. A draft is still open — it is a PR nobody has finished, not one
                        // that went away.
                        state:
                          pr.state === "MERGED"
                            ? ("merged" as const)
                            : pr.state === "CLOSED"
                              ? ("closed" as const)
                              : ("open" as const),
                        mergedAt: pr.mergedAt ?? null,
                      }),
                    ),
                  }),
              ...(parent === undefined ? {} : { parentExternalId: parent }),
              // Spread rather than assigned: `updatedAt: undefined` is a *present* key under
              // exactOptionalPropertyTypes, and the whole point of the optional fields on
              // ExternalIssue is that absent and empty stay different answers.
              ...(content.updatedAt ? { updatedAt: content.updatedAt } : {}),
            }
          : undefined;

      items.push({
        externalId: node.id,
        issueExternalId,
        position: index,
        archivedAt: node.isArchived ? new Date().toISOString() : null,
        values: (node.fieldValues?.nodes ?? [])
          .map(toExternalValue)
          .filter((v): v is ExternalProjectValue => v !== null),
        ...(issue ? { issue } : {}),
      });
    });

    return {
      items,
      nextCursor: page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null,
      drafts,
      pullRequests,
    };
  }

  async writeProjectFieldValue(
    credential: ScmCredential,
    write: ProjectFieldWrite,
  ): Promise<ExternalProjectValue> {
    const data = await scmGraphql<{
      updateProjectV2ItemFieldValue?: {
        projectV2Item?: { fieldValues?: { nodes?: GqlFieldValue[] } };
      };
    }>(PROVIDER, this.graphqlUrl(credential), this.headers(credential), WRITE_MUTATION, {
      project: write.projectExternalId,
      item: write.itemExternalId,
      field: write.fieldExternalId,
      value: toMutationValue(write.value),
    });

    // The value GitHub now *holds*, read back out of the mutation's own answer — never the value
    // that was sent (#122 AC-3). A provider that normalised or refused part of it would otherwise
    // have the operator's own input rendered back at them as though it were stored.
    const stored = (data.updateProjectV2ItemFieldValue?.projectV2Item?.fieldValues?.nodes ?? [])
      .map(toExternalValue)
      .find((v) => v?.fieldExternalId === write.fieldExternalId);
    return stored ?? { fieldExternalId: write.fieldExternalId, value: null };
  }
}
