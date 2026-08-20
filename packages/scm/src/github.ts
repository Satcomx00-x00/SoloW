import { scmFetch } from "./http.js";
import type {
  ChangeProvider,
  ExternalBranch,
  ExternalChangeRequest,
  ExternalIssue,
  ExternalLabel,
  ExternalRepository,
  RepoRef,
  ScmCredential,
} from "./types.js";

/**
 * The reference `ChangeProvider` driver (issue #15). GitHub REST API v3 over plain `fetch` — no
 * SDK, so the interface in `types.ts` is provably the only thing a caller depends on.
 */

interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
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

interface GithubLabel {
  name: string;
  /** Un-prefixed hex, e.g. "d73a4a" — GitHub never includes the leading "#". */
  color: string | null;
  description: string | null;
}

function apiRoot(baseUrl: string | null): string {
  // GitHub Enterprise Server serves its API under /api/v3 on the same host; github.com does not.
  return baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/v3` : "https://api.github.com";
}

function authHeaders(credential: ScmCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export class GithubProvider implements ChangeProvider {
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
    return rows.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      description: r.description,
      defaultBranch: r.default_branch,
      isPrivate: r.private,
      url: r.html_url,
      cloneUrl: r.clone_url,
    }));
  }

  async listIssues(credential: ScmCredential, repo: RepoRef): Promise<ExternalIssue[]> {
    const url = `${apiRoot(credential.baseUrl)}/repos/${repo}/issues?state=all&per_page=100`;
    const rows = (await scmFetch("github", url, authHeaders(credential))) as GithubIssue[];
    // GitHub's issues endpoint returns pull requests too — excluded here so `listIssues` never
    // has to be reconciled against `listChangeRequests` for double-counted rows.
    return rows
      .filter((r) => !("pull_request" in r))
      .map((r) => ({
        externalId: String(r.id),
        number: r.number,
        title: r.title,
        description: r.body,
        state: r.state,
        url: r.html_url,
      }));
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
