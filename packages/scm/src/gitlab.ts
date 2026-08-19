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
 * The GitLab driver (issue #78) — the design test for the `ChangeProvider` interface #15
 * introduced. GitLab's own nouns (issues, merge requests) map onto the neutral domain shape
 * with no new interface member: a merge request becomes a change request at the driver
 * boundary, same as a pull request does on the GitHub side.
 */

interface GitlabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
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

interface GitlabBranch {
  name: string;
  default: boolean;
  commit: { id: string; committed_date: string };
}

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

function mapState(state: GitlabMergeRequest["state"]): ExternalChangeRequest["state"] {
  // "locked" is a transient state (the MR is being merged); the change is committed to
  // whichever side of open/merged it will land on, and treating it as still-open is closer to
  // reality than surfacing a fourth state the domain doesn't otherwise have.
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

export class GitlabProvider implements ChangeProvider {
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

  async listIssues(credential: ScmCredential, repo: RepoRef): Promise<ExternalIssue[]> {
    const url = `${apiRoot(credential.baseUrl)}/projects/${projectPath(repo)}/issues?per_page=100`;
    const rows = (await scmFetch("gitlab", url, authHeaders(credential))) as GitlabIssue[];
    return rows.map((r) => ({
      externalId: String(r.iid),
      number: r.iid,
      title: r.title,
      description: r.description,
      state: r.state === "opened" ? "open" : "closed",
      url: r.web_url,
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
