import { scmFetch } from "./http.js";
import type {
  ChangeProvider,
  ExternalBranch,
  ExternalChangeRequest,
  ExternalIssue,
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
