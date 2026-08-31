import { GithubProjects } from "./github-projects.js";
import {
  enrichConcurrently,
  ISSUE_PAGE_SIZE,
  isNotFound,
  isRateLimited,
  scmFetch,
  scmFetchPaged,
  scmGraphql,
  scmSend,
} from "./http.js";
import {
  type ChangeProvider,
  type EpicSeed,
  type ExternalBranch,
  type ExternalChangeRequest,
  type ExternalComment,
  type ExternalEpic,
  type ExternalGroup,
  type ExternalIssue,
  type ExternalIssueType,
  type ExternalLabel,
  type ExternalLinkedChange,
  type ExternalMilestone,
  type ExternalRepository,
  type ExternalUser,
  type IssueCreatesCapability,
  type IssuePatch,
  type IssueSeed,
  type LabelSeed,
  type ListIssuesOptions,
  type ProjectFieldWrite,
  type ProjectStructureProvisioned,
  type ProjectsCapability,
  type RepoRef,
  type ScmCredential,
  ScmProviderError,
} from "./types.js";

/**
 * The reference `ChangeProvider` driver (issue #15). GitHub REST API v3 over plain `fetch` — no
 * SDK, so the interface in `types.ts` is provably the only thing a caller depends on.
 */

/**
 * One issue read on its own, which carries what a listing does not.
 *
 * GitHub returns assignees, labels and the milestone on every issue object; `listIssues` throws
 * them away because a hundred-issue page does not need them and `ExternalIssue` marks them
 * optional so that "absent" stays distinguishable from "empty". A single read is the opposite
 * case — an editor needs exactly these, current, for the one issue in front of it.
 */
interface GithubIssueDetail extends GithubIssue {
  assignees?: Array<{ login: string; name?: string | null; avatar_url?: string | null }>;
  labels?: Array<{ name: string } | string>;
  milestone?: { number: number; title: string; due_on: string | null } | null;
  updated_at?: string;
}

/** GitHub reports assignees the same shape on every read that carries them at all. */
function mapGithubAssignees(
  assignees: GithubIssueDetail["assignees"],
): NonNullable<ExternalIssue["assignees"]> {
  return (assignees ?? []).map((u) => ({
    login: u.login,
    name: u.name ?? null,
    avatarUrl: u.avatar_url ?? null,
  }));
}

/** GitHub's labels are objects; a few older endpoints answer with bare strings. */
function mapGithubLabels(labels: GithubIssueDetail["labels"]): string[] {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
}

function mapGithubMilestone(
  milestone: GithubIssueDetail["milestone"],
): Exclude<ExternalIssue["milestone"], undefined> {
  return milestone
    ? {
        externalId: String(milestone.number),
        title: milestone.title,
        startDate: null,
        dueDate: milestone.due_on,
      }
    : null;
}

function toDetailedIssue(r: GithubIssueDetail): ExternalIssue {
  return {
    externalId: String(r.id),
    number: r.number,
    title: r.title,
    description: r.body,
    state: r.state,
    url: r.html_url,
    assignees: mapGithubAssignees(r.assignees),
    labels: mapGithubLabels(r.labels),
    milestone: mapGithubMilestone(r.milestone),
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
  };
}

interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  /**
   * The GraphQL global id of the same issue, which REST returns beside the database id. It is
   * what lets one GraphQL call resolve the parents of a whole REST page — see `parentsOf`.
   */
  node_id?: string;
  /** Present (even if null) only on a pull request — GitHub's issues endpoint returns both. */
  pull_request?: unknown;
}

interface GithubPull {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  user: { login: string } | null;
}

/**
 * One timeline entry. Only `cross-referenced` is read; every other event shape is skipped, which
 * is why nothing else is described here.
 */
interface GithubTimelineEvent {
  event: string;
  source?: {
    issue?: {
      id: number;
      number: number;
      title: string;
      state: "open" | "closed";
      html_url: string;
      /** Present only when the cross-reference came from a pull request rather than an issue. */
      pull_request?: { merged_at?: string | null } | null;
    } | null;
  } | null;
}

interface GithubBranch {
  name: string;
  commit: { sha: string };
}

interface GithubRepo {
  default_branch: string;
}

interface GithubRepoSummary {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
}

function toExternalRepository(r: GithubRepoSummary): ExternalRepository {
  return {
    fullName: r.full_name,
    name: r.name,
    description: r.description,
    defaultBranch: r.default_branch,
    isPrivate: r.private,
    url: r.html_url,
    cloneUrl: r.clone_url,
  };
}

interface GithubComment {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at?: string | null;
  user?: { login: string; name?: string | null; avatar_url?: string | null } | null;
}

function toExternalComment(c: GithubComment): ExternalComment {
  return {
    externalId: String(c.id),
    author: c.user
      ? { login: c.user.login, name: c.user.name ?? null, avatarUrl: c.user.avatar_url ?? null }
      : null,
    body: c.body ?? "",
    createdAt: c.created_at,
    // GitHub sets `updated_at` to `created_at` on a comment nobody edited; reporting that as an
    // edit would put "edited" on every comment in the thread.
    updatedAt: c.updated_at && c.updated_at !== c.created_at ? c.updated_at : null,
    url: c.html_url,
  };
}

interface GithubLabel {
  name: string;
  /** Un-prefixed hex, e.g. "d73a4a" — GitHub never includes the leading "#". */
  color: string | null;
  description: string | null;
}

/**
 * How many issues' timelines are read at once. Five rather than "all of them": GitHub's secondary
 * rate limit is about concurrency, and losing a repository's whole sync to it is a far worse trade
 * than a slower poll.
 */
const LINK_FANOUT = 5;

/**
 * The parent of each issue on one page, in one request (spec F23 FR-7, issue #127).
 *
 * **GraphQL, not REST, and the reason is the shape of the answer.** REST reports sub-issues from
 * the parent's side — `GET /issues/{n}/sub_issues` lists an issue's children — so building the
 * edge the mirror stores (a child's parent) would mean walking every issue's children and
 * inverting the result: one request per issue, to learn something about a different issue.
 * GraphQL exposes `parent` on `Issue` directly, and `nodes(ids:)` answers for a hundred of them
 * at once. That is the whole difference between a fixed cost per listing and the per-issue
 * fan-out this same change is removing elsewhere in this file.
 *
 * `databaseId`, not the node id: `listIssues` reports the numeric REST id as `externalId`, and a
 * parent id is only useful in the space its children are matched in.
 */
const PARENTS_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue { databaseId parent { databaseId } }
  }
}`;

/** GraphQL's own cap on `nodes(ids:)`, which is also the REST page size — so normally one call. */
const PARENT_BATCH = 100;

function apiRoot(baseUrl: string | null): string {
  // GitHub Enterprise Server serves its API under /api/v3 on the same host; github.com does not.
  return baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/v3` : "https://api.github.com";
}

/** GraphQL lives beside the REST root on Enterprise Server, and on its own host on github.com. */
function graphqlRoot(baseUrl: string | null): string {
  return baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/graphql` : "https://api.github.com/graphql";
}

function authHeaders(credential: ScmCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export class GithubProvider implements ChangeProvider, ProjectsCapability, IssueCreatesCapability {
  /**
   * Projects v2 lives in its own module: it is GraphQL where everything else here is REST, and
   * mixing the two transports into one file would hide which calls cost API points per query
   * rather than per call. Delegated rather than inherited so the seam stays visible.
   */
  private readonly projects = new GithubProjects();

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

  readonly provider = "github" as const;

  async authenticate(
    credential: ScmCredential,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await scmFetch("github", `${apiRoot(credential.baseUrl)}/user`, authHeaders(credential));
      return { ok: true };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * `/user/repos` rather than `/user/{login}/repos`: the authenticated-user endpoint is the only
   * one that returns private repositories and organisation repositories the token was granted,
   * which is precisely the set a user expects to see offered. Sorted by full name so the list is
   * stable between calls — a picker that reorders itself is worse than one that is merely long.
   */
  async listRepositories(credential: ScmCredential): Promise<ExternalRepository[]> {
    const url = `${apiRoot(credential.baseUrl)}/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`;
    const rows = (await scmFetch("github", url, authHeaders(credential))) as GithubRepoSummary[];
    return rows.map(toExternalRepository);
  }

  async getRepository(
    credential: ScmCredential,
    repo: RepoRef,
  ): Promise<ExternalRepository | null> {
    try {
      const row = (await scmFetch(
        "github",
        `${apiRoot(credential.baseUrl)}/repos/${repo}`,
        authHeaders(credential),
      )) as GithubRepoSummary;
      return toExternalRepository(row);
    } catch (cause) {
      // Absent or invisible — one answer, because GitHub gives one. Anything else (a 401, a 5xx,
      // a throttle) is a failure and rethrows: reporting it as "no such repository" would send
      // the operator to fix a name that was never wrong.
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
      "github",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}`,
      authHeaders(credential),
    )) as GithubIssueDetail;
    return toDetailedIssue(row);
  }

  async listComments(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
  ): Promise<ExternalComment[]> {
    // Every page: a long-running issue collects more than a hundred comments, and returning the
    // first hundred as though they were the discussion is the same silent loss `scmFetchPaged`
    // exists to prevent.
    const rows = await scmFetchPaged<GithubComment>(
      "github",
      (page) =>
        `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      authHeaders(credential),
    );
    return rows.map(toExternalComment);
  }

  async createComment(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<ExternalComment> {
    const row = (await scmSend(
      "github",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}/comments`,
      authHeaders(credential),
      "POST",
      { body },
    )) as GithubComment;
    // What GitHub stored, from its own answer to the write.
    return toExternalComment(row);
  }

  async updateIssue(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
    patch: IssuePatch,
  ): Promise<ExternalIssue> {
    /*
     * Only the keys the patch actually carries.
     *
     * `assignees: []` and no `assignees` key are different requests — the first un-assigns
     * everyone, the second leaves them alone — and an editor that sent its whole form would
     * silently revert whatever it did not display. So absence is preserved rather than
     * normalised to a default.
     */
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.body = patch.description;
    if (patch.state !== undefined) body.state = patch.state;
    if (patch.assignees !== undefined) body.assignees = patch.assignees;
    if (patch.labels !== undefined) body.labels = patch.labels;
    // GitHub identifies a milestone by its number within the repository, and takes null to clear.
    if (patch.milestone !== undefined) {
      body.milestone = patch.milestone === null ? null : Number(patch.milestone);
    }

    const row = (await scmSend(
      "github",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}`,
      authHeaders(credential),
      "PATCH",
      body,
    )) as GithubIssueDetail;
    // What GitHub now holds, from its own answer to the write — never what was sent.
    return toDetailedIssue(row);
  }

  /**
   * POST a new issue and read back what GitHub stored (spec F23a Flow A). REST, not GraphQL,
   * matching `updateIssue` right above it: GitHub takes assignees by login and labels by name on
   * this endpoint directly, so there is no per-provider id resolution to do here the way GitLab's
   * `createIssue` needs `userIdsFor` for.
   *
   * `parentEpicId` is accepted by the seed shape and never sent — GitHub has no epics. Its own
   * parity concept, the sub-issue, arrives as `parentIssueNumber` instead: a separate field
   * because it is a separate thing (an ordinary issue in this repository, not an object in a
   * group), and the manifest declares the two independently for exactly that reason.
   */
  async createIssue(
    credential: ScmCredential,
    repo: RepoRef,
    seed: IssueSeed,
  ): Promise<ExternalIssue> {
    const body: Record<string, unknown> = { title: seed.title };
    if (seed.description !== undefined) body.body = seed.description;
    if (seed.assignees !== undefined) body.assignees = seed.assignees;
    if (seed.labels !== undefined) body.labels = seed.labels;
    if (seed.milestone !== undefined) body.milestone = Number(seed.milestone);
    // The one GitHub extra the create endpoint takes in the body. `type` is the type's *name*,
    // which is what `listIssueTypes` offered the person who picked it.
    if (seed.issueType !== undefined) body.type = seed.issueType;

    const row = (await scmSend(
      "github",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues`,
      authHeaders(credential),
      "POST",
      body,
    )) as GithubIssueDetail;

    await this.applyCreateExtras(credential, repo, row, seed);
    // No re-read after the side effects, for the same reason GitLab's create does not do one:
    // `ExternalIssue` carries neither a parent it did not report on creation nor a board
    // membership nor a dependency, so a second GET would cost a call to return these same fields.
    return toDetailedIssue(row);
  }

  /**
   * The three GitHub extras its create endpoint does not take, applied to the issue it just
   * returned (spec F23a Flow A, user request 2026-08-31).
   *
   * Each is best-effort **in the sense that the issue already exists** — the same rule
   * `GitlabProvider.createIssue` states for its own two side calls. Throwing here would report a
   * failure for a write that plainly succeeded and leave the caller to create the issue a second
   * time, so a refusal is swallowed and the issue is returned as it stands. What comes back is
   * therefore what GitHub holds, which is the F23 NFR-7 rule applied to the case where it held
   * only part of what was asked.
   */
  private async applyCreateExtras(
    credential: ScmCredential,
    repo: RepoRef,
    created: GithubIssueDetail,
    seed: IssueSeed,
  ): Promise<void> {
    const root = apiRoot(credential.baseUrl);

    // Nesting is expressed from the parent's side — the parent gains a sub-issue, by the child's
    // database id — which is the same asymmetry `parentsOf` reads around on the way out.
    if (seed.parentIssueNumber !== undefined) {
      await this.trySideEffect(
        credential,
        `${root}/repos/${repo}/issues/${seed.parentIssueNumber}/sub_issues`,
        { sub_issue_id: created.id },
      );
    }

    for (const link of seed.links ?? []) {
      // GitHub expresses blocking and nothing else, which is what its manifest's `linkTypes`
      // says, so the form never offers "relates to" here. Skipped rather than mapped onto a
      // blocking relation it does not mean: a wrong edge is worse than a missing one.
      if (link.type === "relates_to") continue;
      // One endpoint covers both directions — an issue is told what blocks it — so the pair only
      // has to be ordered correctly. `blocks` means the issue that was picked is the blocked one.
      const blockedNumber = link.type === "blocks" ? link.issueNumber : created.number;
      const blockerNumber = link.type === "blocks" ? created.number : link.issueNumber;
      const blockerId =
        blockerNumber === created.number
          ? created.id
          : await this.issueIdFor(credential, repo, blockerNumber);
      // GitHub names the blocking issue by database id, and a number is all the picker had. A
      // number that resolves to nothing is a link that cannot be made, not a create that failed.
      if (blockerId === null) continue;
      await this.trySideEffect(
        credential,
        `${root}/repos/${repo}/issues/${blockedNumber}/dependencies/blocked_by`,
        { issue_id: blockerId },
      );
    }

    // Projects v2 is GraphQL and takes the issue's node id, which the REST create returns beside
    // the database id. Absent `node_id` means an instance too old to answer with one, and a board
    // that cannot be joined rather than an issue that was not created.
    if (seed.providerProjectId !== undefined && created.node_id) {
      try {
        await this.projects.addIssueToProject(credential, seed.providerProjectId, created.node_id);
      } catch {}
    }
  }

  /** A POST whose failure must not undo the issue it decorates — see `applyCreateExtras`. */
  private async trySideEffect(
    credential: ScmCredential,
    url: string,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await scmSend("github", url, authHeaders(credential), "POST", body);
      return true;
    } catch {
      return false;
    }
  }

  /** One issue's database id from its number, for the endpoints that will not take a number. */
  private async issueIdFor(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
  ): Promise<number | null> {
    try {
      const row = (await scmFetch(
        "github",
        `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}`,
        authHeaders(credential),
      )) as GithubIssue;
      return typeof row?.id === "number" ? row.id : null;
    } catch {
      return null;
    }
  }

  /**
   * The issue types this repository offers — GitHub's own vocabulary, configured on the
   * *organisation* and inherited by its repositories.
   *
   * Which is why a 404 is an empty list rather than an error: a repository owned by a person has
   * no organisation to define types on, and a GitHub Enterprise Server old enough to predate the
   * feature answers the same way. Neither is a failure to read — both are "this repository offers
   * no types", and the picker draws nothing. Any other refusal still surfaces, because a token
   * that cannot see an organisation it should is a fault worth reporting.
   */
  async listIssueTypes(credential: ScmCredential, repo: RepoRef): Promise<ExternalIssueType[]> {
    const owner = repo.split("/")[0];
    if (!owner) return [];
    try {
      const rows = (await scmFetch(
        "github",
        `${apiRoot(credential.baseUrl)}/orgs/${owner}/issue-types`,
        authHeaders(credential),
      )) as Array<{ id: number; name: string; description?: string | null; color?: string | null }>;
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => typeof r?.name === "string" && r.name.length > 0)
        .map((r) => ({
          externalId: String(r.id),
          name: r.name,
          description: r.description ?? null,
          color: r.color ?? null,
        }));
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
  }

  /**
   * The item other issues nest under, originated in a repository (user request 2026-08-31, F23a
   * Part 3).
   *
   * GitHub has no epic object, and this does not invent one: what it creates is an **ordinary
   * issue**, and the only thing that will ever make it a parent is that other issues name it
   * through `sub_issues` — the edge `applyCreateExtras` writes for a child and `parentsOf` reads
   * back as `ExternalIssue.parentExternalId`. That is why the manifest declares
   * `parentPlanningItem: { container: "repository" }` beside an unchanged `epics: false`: what is
   * claimed is the thing GitHub actually has.
   *
   * It delegates rather than repeating the POST so that there is exactly one create path on this
   * driver: a field the endpoint learns to take, or a side effect `applyCreateExtras` grows,
   * applies to both by construction instead of by somebody remembering the second copy.
   *
   * Nothing here writes a hierarchy edge. A parent that itself has a parent is a different
   * request, made by sending `parentIssueNumber` on the seed; creating one draws no edge at all,
   * because the children have not been written yet and they are the side that draws it.
   */
  async createParentPlanningItem(
    credential: ScmCredential,
    repo: RepoRef,
    seed: IssueSeed,
  ): Promise<ExternalIssue> {
    return this.createIssue(credential, repo, seed);
  }

  /**
   * GitHub has no epics (spec F23a Part 1) — the manifest declares `issueCreates.epics: false`
   * (see `packages/scm/src/index.ts`) precisely so a caller never reaches this method: the ＋New
   * menu's parent-item entry routes to `createParentPlanningItem` above, because GitHub's declared
   * container is a repository, and the compose form's Parent-epic picker is what `epics: false`
   * withholds. This throws rather than silently returning nothing so a caller that skipped the
   * manifest check still gets a message that explains itself instead of a confusing runtime shape
   * mismatch.
   */
  async createEpic(
    _credential: ScmCredential,
    _groupRef: string,
    _seed: EpicSeed,
  ): Promise<ExternalEpic> {
    throw new ScmProviderError(
      "github",
      "GitHub has no epics; its parity concept is the sub-issue, created with createParentPlanningItem.",
    );
  }

  async listGroups(_credential: ScmCredential): Promise<ExternalGroup[]> {
    throw new ScmProviderError(
      "github",
      "GitHub has no epics, and therefore no groups to create one in — its parent items live in a repository.",
    );
  }

  async listEpics(_credential: ScmCredential, _groupRef: string): Promise<ExternalEpic[]> {
    throw new ScmProviderError(
      "github",
      "GitHub has no epics; there is no group to list them from.",
    );
  }

  async listAssignableUsers(credential: ScmCredential, repo: RepoRef): Promise<ExternalUser[]> {
    const rows = (await scmFetch(
      "github",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/assignees?per_page=100`,
      authHeaders(credential),
    )) as Array<{ login: string; name?: string | null; avatar_url?: string | null }>;
    return rows.map((u) => ({
      login: u.login,
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
    }));
  }

  async listMilestones(credential: ScmCredential, repo: RepoRef): Promise<ExternalMilestone[]> {
    // `state=all`: a closed milestone is still the answer to "which milestone is this on", and a
    // picker that hid it would show the current value as blank.
    const rows = (await scmFetch(
      "github",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/milestones?state=all&per_page=100`,
      authHeaders(credential),
    )) as Array<{ number: number; title: string; due_on: string | null }>;
    return rows.map((m) => ({
      externalId: String(m.number),
      title: m.title,
      startDate: null,
      dueDate: m.due_on,
    }));
  }

  async listIssues(
    credential: ScmCredential,
    repo: RepoRef,
    options?: ListIssuesOptions,
  ): Promise<ExternalIssue[]> {
    // GitHub filters on `since`, so an incremental poll asks for what changed rather than for
    // the repository (issue #125 AC-2).
    const since = options?.since;
    const query = `state=all&per_page=${ISSUE_PAGE_SIZE}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    // Every page, not the first: one page of 100 returned as though it were the listing is how a
    // 150-issue repository silently lost 50 of them (see `scmFetchPaged`).
    //
    // `GithubIssueDetail`, not the bare `GithubIssue` the type used to say: GitHub's list
    // endpoint returns labels, assignees and the milestone inline on every issue object, the
    // same shape a single-issue read gets — no second request. Only the timeline (linked
    // changes) and the hierarchy (parent) genuinely cost a fetch per issue, which is why those
    // two stay behind their own enrichment below; labels/assignees/milestone were sitting in the
    // response the whole time and simply were not read (bug found 2026-08-28, user-reported: a
    // GitLab repository's Issues showed no labels after #125's automatic sync).
    const rows = await scmFetchPaged<GithubIssueDetail>(
      "github",
      (page) => `${apiRoot(credential.baseUrl)}/repos/${repo}/issues?${query}&page=${page}`,
      authHeaders(credential),
    );
    // GitHub's issues endpoint returns pull requests too — excluded here so `listIssues` never
    // has to be reconciled against `listChangeRequests` for double-counted rows.
    const issues = rows.filter((r) => !("pull_request" in r));

    // Unconditional, unlike the links below, because it costs one request for the whole page
    // however many issues are on it — and because every caller that writes an Issue writes its
    // parent with it, so a listing that skipped this would import a backlog with no hierarchy
    // and no second chance to notice.
    const parents = await this.parentsOf(credential, issues);
    const linked = options?.linkedChangeRequests
      ? await enrichConcurrently(issues, LINK_FANOUT, (r) =>
          this.linkedChanges(credential, repo, r.number),
        )
      : [];

    return issues.map((r, index) => {
      const parent = parents?.get(String(r.id));
      return {
        externalId: String(r.id),
        number: r.number,
        title: r.title,
        description: r.body,
        state: r.state,
        url: r.html_url,
        labels: mapGithubLabels(r.labels),
        assignees: mapGithubAssignees(r.assignees),
        milestone: mapGithubMilestone(r.milestone),
        // Absent, never null, when the hierarchy could not be read at all — see `parentsOf`.
        ...(parent !== undefined ? { parentExternalId: parent } : {}),
        // Absent, never empty, when the timeline could not be read — see `linkedChanges`.
        ...(linked[index] ? { linkedChangeRequests: linked[index] } : {}),
      };
    });
  }

  /**
   * Each issue's parent, keyed by the same id `listIssues` reports as `externalId`.
   *
   * Null for an issue GitHub answered for and said has no parent; **absent from the map** for
   * one it did not answer for at all, so an issue that fell out of the query does not silently
   * lose an edge another poll established.
   *
   * `null` for the whole page when the hierarchy could not be read: a GitHub Enterprise Server
   * old enough to have no `parent` field on `Issue`, or a token GraphQL refuses. Every issue's
   * `parentExternalId` is then omitted — "this provider does not report parents" — rather than
   * reported as none, which would un-nest a project's whole tree on the first bad poll.
   *
   * A rate limit is not degraded, it is rethrown: see `enrichConcurrently` for why a listing
   * that succeeds with a field unknown is the one outcome a watermark makes permanent.
   */
  private async parentsOf(
    credential: ScmCredential,
    issues: readonly GithubIssue[],
  ): Promise<Map<string, string | null> | null> {
    const ids = issues.map((r) => r.node_id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return null;

    const parents = new Map<string, string | null>();
    try {
      for (let at = 0; at < ids.length; at += PARENT_BATCH) {
        const data = await scmGraphql<{
          nodes?: Array<{ databaseId?: number | null; parent?: { databaseId?: number } | null }>;
        }>("github", graphqlRoot(credential.baseUrl), authHeaders(credential), PARENTS_QUERY, {
          ids: ids.slice(at, at + PARENT_BATCH),
        });
        for (const node of data.nodes ?? []) {
          // A node that is not an Issue answers the fragment with nothing; skipped rather than
          // recorded, because "GitHub returned a shape we did not ask about" is not "no parent".
          if (!node?.databaseId) continue;
          const parent = node.parent?.databaseId;
          parents.set(String(node.databaseId), parent ? String(parent) : null);
        }
      }
    } catch (cause) {
      if (isRateLimited(cause)) throw cause;
      return null;
    }
    return parents;
  }

  /**
   * The change requests GitHub itself links to one issue (spec F23 FR-8, issue #128).
   *
   * Read from the issue timeline's `cross-referenced` events, which is the set REST exposes.
   * GraphQL's `closingIssuesReferences` is the narrower "this will close it" list; the timeline
   * is the superset a reviewer actually asked for, because a pull request that merely mentions
   * the issue is still what is in flight for it.
   *
   * **It throws rather than swallowing**, which it used to do. `enrichConcurrently` is what turns
   * an ordinary failure into `undefined` — the caller then omits the field, the sync keeps the
   * links it last confirmed, and one failed extra request costs nothing — while a 429 fails the
   * listing instead of being spent as "nothing is in flight here".
   */
  private async linkedChanges(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
  ): Promise<ExternalLinkedChange[]> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}/timeline?per_page=100`;
    const events = (await scmFetch(
      "github",
      url,
      authHeaders(credential),
    )) as GithubTimelineEvent[];
    // An issue is commonly cross-referenced by the same pull request several times — once per
    // mention. Keyed by the provider's id so the row is one badge per change request, not one
    // per comment that named it.
    const byId = new Map<string, ExternalLinkedChange>();
    for (const event of events) {
      if (event.event !== "cross-referenced") continue;
      const source = event.source?.issue;
      if (!source?.pull_request) continue;
      const mergedAt = source.pull_request.merged_at ?? null;
      byId.set(String(source.id), {
        externalId: String(source.id),
        number: source.number,
        title: source.title,
        state: mergedAt ? "merged" : source.state,
        url: source.html_url,
        mergedAt,
      });
    }
    return [...byId.values()];
  }

  async listChangeRequests(
    credential: ScmCredential,
    repo: RepoRef,
  ): Promise<ExternalChangeRequest[]> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/pulls?state=all&per_page=100`;
    const rows = (await scmFetch("github", url, authHeaders(credential))) as GithubPull[];
    return rows.map((r) => ({
      externalId: String(r.id),
      number: r.number,
      title: r.title,
      state: r.merged_at ? "merged" : r.state,
      url: r.html_url,
      headRef: r.head.ref,
      baseRef: r.base.ref,
      authorLogin: r.user?.login ?? null,
    }));
  }

  /**
   * `color` comes back un-prefixed ("d73a4a") — normalized to `#RRGGBB` here so every caller
   * gets one consistent swatch format instead of reimplementing the prefix (GitLab's driver
   * passes its own `#`-prefixed color through unchanged for the same reason).
   */
  async listLabels(credential: ScmCredential, repo: RepoRef): Promise<ExternalLabel[]> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/labels?per_page=100`;
    const rows = (await scmFetch("github", url, authHeaders(credential))) as GithubLabel[];
    return rows.map((r) => ({
      name: r.name,
      color: r.color ? `#${r.color}` : null,
      description: r.description,
    }));
  }

  /**
   * Create every label in `labels` this repository does not already have (user request
   * 2026-08-27). Matching is case-insensitive against `listLabels`'s own answer, so a repository
   * that already spells one of these some other way is not given a near-duplicate.
   */
  async createLabels(
    credential: ScmCredential,
    repo: RepoRef,
    labels: LabelSeed[],
  ): Promise<ProjectStructureProvisioned> {
    const present = new Set(
      (await this.listLabels(credential, repo)).map((l) => l.name.toLowerCase()),
    );
    const created: string[] = [];
    const existing: string[] = [];
    for (const label of labels) {
      if (present.has(label.name.toLowerCase())) {
        existing.push(label.name);
        continue;
      }
      await scmSend(
        "github",
        `${apiRoot(credential.baseUrl)}/repos/${repo}/labels`,
        authHeaders(credential),
        "POST",
        // GitHub takes `color` unprefixed, unlike the `#RRGGBB` `listLabels` normalizes it to.
        {
          name: label.name,
          color: label.color.replace(/^#/, ""),
          description: label.description ?? "",
        },
      );
      created.push(label.name);
    }
    return { created, existing };
  }

  async listBranches(credential: ScmCredential, repo: RepoRef): Promise<ExternalBranch[]> {
    const root = apiRoot(credential.baseUrl);
    const headers = authHeaders(credential);
    const [repoInfo, branches] = await Promise.all([
      scmFetch("github", `${root}/repos/${repo}`, headers) as Promise<GithubRepo>,
      scmFetch("github", `${root}/repos/${repo}/branches?per_page=100`, headers) as Promise<
        GithubBranch[]
      >,
    ]);
    return branches.map((b) => ({
      name: b.name,
      isDefault: b.name === repoInfo.default_branch,
      headSha: b.commit.sha,
      // The branches list endpoint doesn't carry a commit timestamp; a second call per branch
      // to fetch it would turn one sync into N+1 requests for no benefit the UI asks for today.
      headCommittedAt: null,
    }));
  }
}
