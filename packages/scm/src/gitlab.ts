import { GitlabProjects } from "./gitlab-projects.js";
import {
  enrichConcurrently,
  ISSUE_PAGE_SIZE,
  isNotFound,
  scmFetch,
  scmFetchPaged,
  scmSend,
} from "./http.js";
import type {
  ChangeProvider,
  ExternalBranch,
  ExternalChangeRequest,
  ExternalIssue,
  ExternalLabel,
  ExternalLinkedChange,
  ExternalMilestone,
  ExternalRepository,
  ExternalUser,
  IssuePatch,
  ListIssuesOptions,
  ProjectFieldWrite,
  ProjectsCapability,
  RepoRef,
  ScmCredential,
} from "./types.js";

/**
 * The GitLab driver (issue #78) — the design test for the `ChangeProvider` interface #15
 * introduced. GitLab's own nouns (issues, merge requests) map onto the neutral domain shape
 * with no new interface member: a merge request becomes a change request at the driver
 * boundary, same as a pull request does on the GitHub side.
 */

/** One issue read alone: GitLab returns the assignees, labels and milestone a listing drops. */
interface GitlabIssueDetail extends GitlabIssue {
  assignees?: Array<{ username: string; name?: string | null; avatar_url?: string | null }>;
  labels?: string[];
  milestone?: {
    id: number;
    title: string;
    start_date: string | null;
    due_date: string | null;
  } | null;
  updated_at?: string;
}

function toDetailedIssue(r: GitlabIssueDetail): ExternalIssue {
  return {
    externalId: String(r.iid),
    number: r.iid,
    title: r.title,
    description: r.description,
    state: r.state === "opened" ? "open" : "closed",
    url: r.web_url,
    assignees: (r.assignees ?? []).map((u) => ({
      login: u.username,
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
    })),
    labels: r.labels ?? [],
    milestone: r.milestone
      ? {
          externalId: String(r.milestone.id),
          title: r.milestone.title,
          startDate: r.milestone.start_date,
          dueDate: r.milestone.due_date,
        }
      : null,
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
  };
}

interface GitlabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
  /**
   * The epic this issue belongs to — GitLab's own answer to "what is this issue's parent".
   *
   * Optional in the strong sense: the key is **absent** on a tier without epics, present and
   * null on a tier with them when the issue is in none. That difference is the tier degradation,
   * read straight off the payload rather than guessed at from a plan name (`epicParentId`).
   */
  epic?: { id: number } | null;
}

interface GitlabMergeRequest {
  iid: number;
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: { username: string } | null;
}

/**
 * A merge request as the related-merge-requests endpoint returns it — a subset of the full MR
 * shape, described separately because a badge needs less than `listChangeRequests` does.
 */
interface GitlabRelatedMergeRequest {
  id: number;
  iid: number;
  title: string;
  state: GitlabMergeRequest["state"];
  web_url: string;
  merged_at: string | null;
}

interface GitlabBranch {
  name: string;
  default: boolean;
  commit: { id: string; committed_date: string };
}

function toExternalRepository(r: GitlabProject): ExternalRepository {
  return {
    fullName: r.path_with_namespace,
    name: r.name,
    description: r.description,
    defaultBranch: r.default_branch,
    // GitLab has three visibilities; only `public` is genuinely open, so "internal" counts as
    // private here rather than being reported to the user as if anyone could read it.
    isPrivate: r.visibility !== "public",
    url: r.web_url,
    cloneUrl: r.http_url_to_repo,
  };
}

interface GitlabProject {
  name: string;
  path_with_namespace: string;
  description: string | null;
  default_branch: string | null;
  visibility: "private" | "internal" | "public";
  web_url: string;
  http_url_to_repo: string;
}

interface GitlabLabel {
  name: string;
  /** GitLab already returns "#RRGGBB" — nothing to normalize, unlike GitHub's driver. */
  color: string | null;
  description: string | null;
}

/**
 * How many issues' related merge requests are read at once. Bounded for the same reason GitHub's
 * is: a poll that trips a rate limit stops syncing the repository, where a slower poll costs
 * only seconds.
 */
const LINK_FANOUT = 5;

function apiRoot(baseUrl: string | null): string {
  return `${(baseUrl ?? "https://gitlab.com").replace(/\/$/, "")}/api/v4`;
}

function authHeaders(credential: ScmCredential): Record<string, string> {
  return { "PRIVATE-TOKEN": credential.token };
}

/** GitLab addresses a project by numeric id or by its URL-encoded "namespace/path". */
function projectPath(repo: RepoRef): string {
  return encodeURIComponent(repo);
}

/**
 * An issue's parent, as far as GitLab is able to report one (spec F23 FR-7, issue #127).
 *
 * Three answers, and the tier decides which is available:
 *
 * - **Absent** (`undefined`) — the payload carries no `epic` key at all, which is what GitLab
 *   Free returns because epics are a paid feature. Honest as absence: the mirror leaves whatever
 *   edge it already had, rather than reporting "no parent" on a plan that cannot have one.
 * - **`null`** — epics exist here and this issue is in none. An answer, and it un-nests the row.
 * - **`epic-<id>`** — the epic's instance-wide database id, prefixed.
 *
 * The prefix is the part worth explaining. An issue's `externalId` here is its `iid`, which
 * restarts at 1 in every project, while an epic's `id` is a global counter — so an unprefixed
 * `42` would be matched against issue #42 of the child's own repository and nest a row under a
 * stranger, the exact failure F23 calls worse than leaving it at the top level. Prefixed, it can
 * only ever match another epic, which is to say nothing yet: epics live in a group and are not
 * imported as issues, so such a child renders at the top level today. The value is still stored,
 * because a parent that has not been imported yet is what the mirror is written to recognise
 * when it arrives.
 */
function epicParentId(row: GitlabIssue): string | null | undefined {
  if (!("epic" in row)) return undefined;
  return row.epic ? `epic-${row.epic.id}` : null;
}

function mapState(state: GitlabMergeRequest["state"]): ExternalChangeRequest["state"] {
  // "locked" is a transient state (the MR is being merged); the change is committed to
  // whichever side of open/merged it will land on, and treating it as still-open is closer to
  // reality than surfacing a fourth state the domain doesn't otherwise have.
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

export class GitlabProvider implements ChangeProvider, ProjectsCapability {
  /**
   * Planning lives in its own module because it is a different *idea*, not a different endpoint:
   * scoped labels standing in for a field store (Decision 0018). Keeping it beside `listIssues`
   * would make the synthesis look like an ordinary read.
   */
  private readonly projects = new GitlabProjects();

  listProjects(credential: ScmCredential) {
    return this.projects.listProjects(credential);
  }
  readProjectFields(credential: ScmCredential, projectExternalId: string) {
    return this.projects.readProjectFields(credential, projectExternalId);
  }
  readProjectItems(credential: ScmCredential, projectExternalId: string, cursor: string | null) {
    return this.projects.readProjectItems(credential, projectExternalId, cursor);
  }
  writeProjectFieldValue(credential: ScmCredential, write: ProjectFieldWrite) {
    return this.projects.writeProjectFieldValue(credential, write);
  }
  provisionProjectStructure(credential: ScmCredential, projectExternalId: string) {
    return this.projects.provisionProjectStructure(credential, projectExternalId);
  }

  readonly provider = "gitlab" as const;

  async authenticate(
    credential: ScmCredential,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await scmFetch("gitlab", `${apiRoot(credential.baseUrl)}/user`, authHeaders(credential));
      return { ok: true };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * `membership=true` restricts the list to projects the token's user actually belongs to.
   * Without it GitLab returns every *public* project on the instance — thousands of strangers'
   * repositories on gitlab.com — which is not a picker, it is a denial of service on the user.
   *
   * `path_with_namespace` is the value every other method here takes as its `RepoRef`, so what
   * the user picks is what gets stored and later URL-encoded for the per-project endpoints.
   */
  async listRepositories(credential: ScmCredential): Promise<ExternalRepository[]> {
    const url = `${apiRoot(credential.baseUrl)}/projects?membership=true&per_page=100&order_by=path&sort=asc`;
    const rows = (await scmFetch("gitlab", url, authHeaders(credential))) as GitlabProject[];
    return rows.map(toExternalRepository);
  }

  async getRepository(
    credential: ScmCredential,
    repo: RepoRef,
  ): Promise<ExternalRepository | null> {
    try {
      // GitLab addresses a project by its URL-encoded path, slashes included — a nested group
      // ("group/sub/repo") is three segments that must arrive as one.
      const row = (await scmFetch(
        "gitlab",
        `${apiRoot(credential.baseUrl)}/projects/${encodeURIComponent(repo)}`,
        authHeaders(credential),
      )) as GitlabProject;
      return toExternalRepository(row);
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  async getIssue(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
  ): Promise<ExternalIssue> {
    const row = (await scmFetch(
      "gitlab",
      `${apiRoot(credential.baseUrl)}/projects/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      authHeaders(credential),
    )) as GitlabIssueDetail;
    return toDetailedIssue(row);
  }

  async updateIssue(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
    patch: IssuePatch,
  ): Promise<ExternalIssue> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    // GitLab does not take a state; it takes an *event*. Sending `state: "closed"` is accepted
    // and ignored, which is a write that reports success and changes nothing.
    if (patch.state !== undefined) body.state_event = patch.state === "closed" ? "close" : "reopen";
    if (patch.labels !== undefined) {
      // A comma-joined string, and an empty one is how GitLab is told to clear them.
      body.labels = patch.labels.join(",");
    }
    if (patch.milestone !== undefined) {
      // 0, not null: GitLab clears a milestone with a zero id and ignores a null.
      body.milestone_id = patch.milestone === null ? 0 : Number(patch.milestone);
    }
    if (patch.assignees !== undefined) {
      // GitLab assigns by numeric user id, never by username, so the logins an editor works in
      // have to be resolved first. An unknown login is dropped rather than failing the whole
      // patch — the answer read back then simply does not contain them, which is the truth.
      const ids = await this.userIdsFor(credential, repo, patch.assignees);
      body.assignee_ids = ids;
    }

    const row = (await scmSend(
      "gitlab",
      `${apiRoot(credential.baseUrl)}/projects/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      authHeaders(credential),
      "PUT",
      body,
    )) as GitlabIssueDetail;
    return toDetailedIssue(row);
  }

  async listAssignableUsers(credential: ScmCredential, repo: RepoRef): Promise<ExternalUser[]> {
    const rows = (await scmFetch(
      "gitlab",
      `${apiRoot(credential.baseUrl)}/projects/${encodeURIComponent(repo)}/users?per_page=100`,
      authHeaders(credential),
    )) as Array<{ id: number; username: string; name?: string | null; avatar_url?: string | null }>;
    return rows.map((u) => ({
      login: u.username,
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
    }));
  }

  async listMilestones(credential: ScmCredential, repo: RepoRef): Promise<ExternalMilestone[]> {
    const rows = (await scmFetch(
      "gitlab",
      `${apiRoot(credential.baseUrl)}/projects/${encodeURIComponent(repo)}/milestones?per_page=100`,
      authHeaders(credential),
    )) as Array<{ id: number; title: string; start_date: string | null; due_date: string | null }>;
    return rows.map((m) => ({
      externalId: String(m.id),
      title: m.title,
      startDate: m.start_date,
      dueDate: m.due_date,
    }));
  }

  /** Logins → GitLab's numeric ids, for the one API that will not take a username. */
  private async userIdsFor(
    credential: ScmCredential,
    repo: RepoRef,
    logins: readonly string[],
  ): Promise<number[]> {
    if (logins.length === 0) return [];
    const rows = (await scmFetch(
      "gitlab",
      `${apiRoot(credential.baseUrl)}/projects/${encodeURIComponent(repo)}/users?per_page=100`,
      authHeaders(credential),
    )) as Array<{ id: number; username: string }>;
    const byLogin = new Map(rows.map((u) => [u.username.toLowerCase(), u.id]));
    return logins
      .map((login) => byLogin.get(login.toLowerCase()))
      .filter((id): id is number => id !== undefined);
  }

  async listIssues(
    credential: ScmCredential,
    repo: RepoRef,
    options?: ListIssuesOptions,
  ): Promise<ExternalIssue[]> {
    // GitLab spells the same filter `updated_after` (issue #125 AC-2).
    const since = options?.since;
    const query = `per_page=${ISSUE_PAGE_SIZE}${since ? `&updated_after=${encodeURIComponent(since)}` : ""}`;
    const rows = await scmFetchPaged<GitlabIssue>(
      "gitlab",
      (page) =>
        `${apiRoot(credential.baseUrl)}/projects/${projectPath(repo)}/issues?${query}&page=${page}`,
      authHeaders(credential),
    );
    // The hierarchy costs nothing here — GitLab puts the epic on the issue itself, where GitHub
    // needs a second query for it — so it is read unconditionally and only the links are opt-in.
    const linked = options?.linkedChangeRequests
      ? await enrichConcurrently(rows, LINK_FANOUT, (r) =>
          this.linkedChanges(credential, repo, r.iid),
        )
      : [];
    return rows.map((r, index) => {
      const parent = epicParentId(r);
      return {
        externalId: String(r.iid),
        number: r.iid,
        title: r.title,
        description: r.description,
        state: r.state === "opened" ? "open" : ("closed" as const),
        url: r.web_url,
        // Absent on a tier without epics — see `epicParentId`.
        ...(parent !== undefined ? { parentExternalId: parent } : {}),
        // Absent, not emptied, when the call failed — see `linkedChanges`.
        ...(linked[index] ? { linkedChangeRequests: linked[index] } : {}),
      };
    });
  }

  /**
   * The merge requests GitLab itself relates to one issue (spec F23 FR-8, issue #128).
   *
   * `related_merge_requests` is GitLab's own answer to the question — it covers both the MRs that
   * close the issue and the ones that merely reference it — so nothing here has to parse a
   * description for "Closes #12".
   *
   * **It throws rather than swallowing.** `enrichConcurrently` degrades an ordinary failure to
   * `undefined`, so the caller omits the field and the sync keeps the links it last confirmed;
   * a 429 fails the listing instead of being recorded as "nothing is in flight".
   */
  private async linkedChanges(
    credential: ScmCredential,
    repo: RepoRef,
    issueIid: number,
  ): Promise<ExternalLinkedChange[]> {
    const url = `${apiRoot(credential.baseUrl)}/projects/${projectPath(repo)}/issues/${issueIid}/related_merge_requests`;
    const rows = (await scmFetch(
      "gitlab",
      url,
      authHeaders(credential),
    )) as GitlabRelatedMergeRequest[];
    return rows.map((r) => ({
      // The MR's global `id`, not its per-project `iid`: `iid` restarts at 1 in every project,
      // which is the same collision `issue_repository_external` exists to avoid.
      externalId: String(r.id),
      number: r.iid,
      title: r.title,
      state: mapState(r.state),
      url: r.web_url,
      mergedAt: r.merged_at,
    }));
  }

  async listChangeRequests(
    credential: ScmCredential,
    repo: RepoRef,
  ): Promise<ExternalChangeRequest[]> {
    const url = `${apiRoot(credential.baseUrl)}/projects/${projectPath(repo)}/merge_requests?per_page=100`;
    const rows = (await scmFetch("gitlab", url, authHeaders(credential))) as GitlabMergeRequest[];
    return rows.map((r) => ({
      externalId: String(r.iid),
      number: r.iid,
      title: r.title,
      state: mapState(r.state),
      url: r.web_url,
      headRef: r.source_branch,
      baseRef: r.target_branch,
      authorLogin: r.author?.username ?? null,
    }));
  }

  /** GitLab returns `color` already prefixed with "#" — passed through as-is, unlike GitHub's. */
  async listLabels(credential: ScmCredential, repo: RepoRef): Promise<ExternalLabel[]> {
    const url = `${apiRoot(credential.baseUrl)}/projects/${projectPath(repo)}/labels?per_page=100`;
    const rows = (await scmFetch("gitlab", url, authHeaders(credential))) as GitlabLabel[];
    return rows.map((r) => ({ name: r.name, color: r.color, description: r.description }));
  }

  async listBranches(credential: ScmCredential, repo: RepoRef): Promise<ExternalBranch[]> {
    const url = `${apiRoot(credential.baseUrl)}/projects/${projectPath(repo)}/repository/branches?per_page=100`;
    const rows = (await scmFetch("gitlab", url, authHeaders(credential))) as GitlabBranch[];
    return rows.map((r) => ({
      name: r.name,
      isDefault: r.default,
      headSha: r.commit.id,
      headCommittedAt: r.commit.committed_date,
    }));
  }
}
