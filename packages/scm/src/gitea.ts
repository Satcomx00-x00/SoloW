import { ISSUE_PAGE_SIZE, isNotFound, scmFetch, scmFetchPaged, scmSend } from "./http.js";
import type {
  ChangeProvider,
  ExternalBranch,
  ExternalChangeRequest,
  ExternalComment,
  ExternalIssue,
  ExternalLabel,
  ExternalMilestone,
  ExternalRepository,
  ExternalUser,
  IssuePatch,
  ListIssuesOptions,
  RepoRef,
  ScmCredential,
} from "./types.js";

/**
 * Gitea, the third driver — and the reason it exists (F21, Decision 0016).
 *
 * Issue #78 added GitLab to test the `ChangeProvider` abstraction rather than assume it. This
 * one plays the same role for the registry: if adding Gitea required touching anything outside
 * this file and one registration, the registry has not actually removed what it claimed to. It
 * did not, and that is the evidence — no schema, no enum, no picker and no label table changed
 * to make room for it.
 *
 * Gitea's API is deliberately GitHub-shaped, which is convenient and also a trap: it is
 * *similar*, not identical, and three differences matter here.
 *
 * - **Everything is under `/api/v1`, always.** There is no hosted SaaS with a different root the
 *   way github.com has, so `baseUrl` is required rather than optional — a Gitea with no host is
 *   not a Gitea. Codeberg and every self-hosted instance are the same shape.
 * - **The token is sent as `token <value>`,** not as a bearer. A bearer works on newer versions
 *   and not on older ones; `token` works on all of them.
 * - **Issues and pull requests share a number space and an endpoint,** exactly as on GitHub, so
 *   the same `pull_request` discriminator is needed to keep change requests out of the issue
 *   list. Getting this wrong shows up as change requests appearing as importable Issues, which
 *   is the bug the GitHub driver already documents.
 */

/** One issue read alone — Gitea answers with the assignees, labels and milestone. */
interface GiteaIssueDetail extends GiteaIssue {
  assignees?: Array<{
    login: string;
    full_name?: string | null;
    avatar_url?: string | null;
  }> | null;
  labels?: Array<{ name: string }>;
  milestone?: { id: number; title: string; due_on: string | null } | null;
  updated_at?: string;
}

function toDetailedIssue(r: GiteaIssueDetail): ExternalIssue {
  return {
    externalId: String(r.id),
    number: r.number,
    title: r.title,
    description: r.body,
    state: r.state,
    url: r.html_url,
    assignees: (r.assignees ?? []).map((u) => ({
      login: u.login,
      name: u.full_name || null,
      avatarUrl: u.avatar_url ?? null,
    })),
    labels: (r.labels ?? []).map((l) => l.name),
    milestone: r.milestone
      ? {
          externalId: String(r.milestone.id),
          title: r.milestone.title,
          startDate: null,
          dueDate: r.milestone.due_on,
        }
      : null,
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
  };
}

interface GiteaComment {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at?: string | null;
  user?: { login: string; full_name?: string | null; avatar_url?: string | null } | null;
}

function toExternalComment(c: GiteaComment): ExternalComment {
  return {
    externalId: String(c.id),
    author: c.user
      ? {
          login: c.user.login,
          name: c.user.full_name || null,
          avatarUrl: c.user.avatar_url ?? null,
        }
      : null,
    body: c.body ?? "",
    createdAt: c.created_at,
    updatedAt: c.updated_at && c.updated_at !== c.created_at ? c.updated_at : null,
    url: c.html_url,
  };
}

interface GiteaIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  /** Present only on a pull request — Gitea's issues endpoint returns both, as GitHub's does. */
  pull_request?: unknown;
}

interface GiteaPull {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  user: { login: string } | null;
}

interface GiteaBranch {
  name: string;
  commit: { id: string; timestamp?: string | null };
}

function toExternalRepository(r: GiteaRepo): ExternalRepository {
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

interface GiteaRepo {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
}

interface GiteaLabel {
  name: string;
  /** Un-prefixed hex, as GitHub returns it. Normalised to `#RRGGBB` at this boundary. */
  color: string | null;
  description: string | null;
}

/**
 * Gitea has no public SaaS root, so there is nothing sensible to fall back to. A null `baseUrl`
 * is a configuration error rather than "use the default host", and saying so here beats issuing
 * a request to `/api/v1` on nothing.
 */
function apiRoot(baseUrl: string | null): string {
  if (!baseUrl) {
    throw new Error("gitea requires a base URL — there is no hosted instance to default to");
  }
  return `${baseUrl.replace(/\/$/, "")}/api/v1`;
}

function authHeaders(credential: ScmCredential): Record<string, string> {
  return {
    Authorization: `token ${credential.token}`,
    Accept: "application/json",
  };
}

/** `d73a4a` → `#d73a4a`; a value already prefixed, or absent, is left as it is. */
function normalizeColor(color: string | null): string | null {
  if (!color) return null;
  return color.startsWith("#") ? color : `#${color}`;
}

export class GiteaProvider implements ChangeProvider {
  readonly provider = "gitea" as const;

  async authenticate(
    credential: ScmCredential,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await scmFetch("gitea", `${apiRoot(credential.baseUrl)}/user`, authHeaders(credential));
      return { ok: true };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * `/user/repos` for the same reason GitHub's driver uses it: it is the endpoint that returns
   * private and organisation repositories the token was actually granted, which is the set a
   * user expects to be offered. Gitea does not accept GitHub's `sort=full_name`, so the ordering
   * is applied here — a picker that reorders itself between calls is worse than a long one.
   */
  async listRepositories(credential: ScmCredential): Promise<ExternalRepository[]> {
    const url = `${apiRoot(credential.baseUrl)}/user/repos?limit=100`;
    const rows = (await scmFetch("gitea", url, authHeaders(credential))) as GiteaRepo[];
    return rows.map(toExternalRepository).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async getRepository(
    credential: ScmCredential,
    repo: RepoRef,
  ): Promise<ExternalRepository | null> {
    try {
      const row = (await scmFetch(
        "gitea",
        `${apiRoot(credential.baseUrl)}/repos/${repo}`,
        authHeaders(credential),
      )) as GiteaRepo;
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
      "gitea",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}`,
      authHeaders(credential),
    )) as GiteaIssueDetail;
    return toDetailedIssue(row);
  }

  async listComments(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
  ): Promise<ExternalComment[]> {
    const rows = (await scmFetch(
      "gitea",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}/comments`,
      authHeaders(credential),
    )) as GiteaComment[];
    return rows.map(toExternalComment);
  }

  async createComment(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<ExternalComment> {
    const row = (await scmSend(
      "gitea",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}/comments`,
      authHeaders(credential),
      "POST",
      { body },
    )) as GiteaComment;
    return toExternalComment(row);
  }

  async updateIssue(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
    patch: IssuePatch,
  ): Promise<ExternalIssue> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/issues/${issueNumber}`;
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.body = patch.description;
    if (patch.state !== undefined) body.state = patch.state;
    if (patch.assignees !== undefined) body.assignees = patch.assignees;
    if (patch.milestone !== undefined) {
      // Gitea clears a milestone with 0, as GitLab does, and rejects a null.
      body.milestone = patch.milestone === null ? 0 : Number(patch.milestone);
    }

    /*
     * Labels are a second request, because Gitea's issue PATCH does not take them — it takes
     * label *ids* nowhere and ignores the key. The dedicated endpoint takes names.
     *
     * Sent first, so that when it fails the issue is left untouched rather than half-edited: a
     * title that landed beside labels that did not is the state hardest to reason about
     * afterwards, since nothing on screen says which half happened.
     */
    if (patch.labels !== undefined) {
      await scmSend("gitea", `${url}/labels`, authHeaders(credential), "PUT", {
        labels: patch.labels,
      });
    }

    const row = (await scmSend(
      "gitea",
      url,
      authHeaders(credential),
      "PATCH",
      body,
    )) as GiteaIssueDetail;
    return toDetailedIssue(row);
  }

  async listAssignableUsers(credential: ScmCredential, repo: RepoRef): Promise<ExternalUser[]> {
    const rows = (await scmFetch(
      "gitea",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/assignees`,
      authHeaders(credential),
    )) as Array<{ login: string; full_name?: string | null; avatar_url?: string | null }>;
    return rows.map((u) => ({
      login: u.login,
      name: u.full_name || null,
      avatarUrl: u.avatar_url ?? null,
    }));
  }

  async listMilestones(credential: ScmCredential, repo: RepoRef): Promise<ExternalMilestone[]> {
    const rows = (await scmFetch(
      "gitea",
      `${apiRoot(credential.baseUrl)}/repos/${repo}/milestones?state=all`,
      authHeaders(credential),
    )) as Array<{ id: number; title: string; due_on: string | null }>;
    return rows.map((m) => ({
      externalId: String(m.id),
      title: m.title,
      startDate: null,
      dueDate: m.due_on,
    }));
  }

  /**
   * Pull requests are filtered out by the `pull_request` key, not by a state check: on Gitea as
   * on GitHub the issues endpoint returns both, and a change request shown as an importable
   * Issue is a Task opened against the wrong thing.
   *
   * **Neither `parentExternalId` nor `linkedChangeRequests` is set, and both omissions are the
   * answer rather than a gap.** Gitea has no sub-issue or epic concept at all — it relates
   * issues by dependency, which is a different claim — and no endpoint that reports which pull
   * requests reference one. Absent means "this provider does not report that"; `null` and `[]`
   * would both be Gitea asserting something it has never been asked. The mirror reads the
   * difference: an absent parent leaves an edge alone, a null one erases it (F23 FR-7).
   *
   * `linkedChangeRequests` is therefore absent even when a caller opts in — asking a provider
   * for a capability it does not have costs nothing here, and answers nothing.
   */
  async listIssues(
    credential: ScmCredential,
    repo: RepoRef,
    options?: ListIssuesOptions,
  ): Promise<ExternalIssue[]> {
    // Gitea follows GitHub's spelling here, as it does for most of this API.
    const since = options?.since;
    const query = `state=all&limit=${ISSUE_PAGE_SIZE}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const rows = await scmFetchPaged<GiteaIssue>(
      "gitea",
      (page) => `${apiRoot(credential.baseUrl)}/repos/${repo}/issues?${query}&page=${page}`,
      authHeaders(credential),
    );
    return rows
      .filter((r) => r.pull_request === undefined || r.pull_request === null)
      .map((r) => ({
        externalId: String(r.id),
        number: r.number,
        title: r.title,
        description: r.body,
        state: r.state,
        url: r.html_url,
      }));
  }

  /**
   * Gitea reports merged as a boolean beside the state, where GitHub infers it from
   * `merged_at`. Both collapse onto the domain's three states, and the domain says **change
   * request** — Gitea's own noun is "pull request" and stays in the manifest, for display.
   */
  async listChangeRequests(
    credential: ScmCredential,
    repo: RepoRef,
  ): Promise<ExternalChangeRequest[]> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/pulls?state=all&limit=100`;
    const rows = (await scmFetch("gitea", url, authHeaders(credential))) as GiteaPull[];
    return rows.map((r) => ({
      externalId: String(r.id),
      number: r.number,
      title: r.title,
      state: r.merged ? "merged" : r.state,
      url: r.html_url,
      headRef: r.head.ref,
      baseRef: r.base.ref,
      authorLogin: r.user?.login ?? null,
    }));
  }

  async listLabels(credential: ScmCredential, repo: RepoRef): Promise<ExternalLabel[]> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/labels?limit=100`;
    const rows = (await scmFetch("gitea", url, authHeaders(credential))) as GiteaLabel[];
    return rows.map((r) => ({
      name: r.name,
      color: normalizeColor(r.color),
      description: r.description,
    }));
  }

  /**
   * Two calls, because which branch is default lives on the repository and not on the branch —
   * the same shape the GitHub driver uses. Gitea's branch payload carries the commit timestamp
   * where GitHub's does not, so `headCommittedAt` is real here rather than null.
   */
  async listBranches(credential: ScmCredential, repo: RepoRef): Promise<ExternalBranch[]> {
    const root = apiRoot(credential.baseUrl);
    const headers = authHeaders(credential);
    const [repoInfo, branches] = await Promise.all([
      scmFetch("gitea", `${root}/repos/${repo}`, headers) as Promise<GiteaRepo>,
      scmFetch("gitea", `${root}/repos/${repo}/branches?limit=100`, headers) as Promise<
        GiteaBranch[]
      >,
    ]);
    return branches.map((b) => ({
      name: b.name,
      isDefault: b.name === repoInfo.default_branch,
      headSha: b.commit.id,
      headCommittedAt: b.commit.timestamp ?? null,
    }));
  }
}
