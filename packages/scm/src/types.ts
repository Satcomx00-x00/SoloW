/**
 * The `ChangeProvider` boundary (issue #15). One interface, GitHub as the reference driver,
 * GitLab a second driver over the same shape (issue #78) — validated, not assumed, since #78's
 * whole purpose is to be the design test for this abstraction.
 *
 * Terminology stays neutral in the domain (issue #15's explicit rule): GitHub has pull
 * requests, GitLab has merge requests — the domain says **change request**, and each driver
 * translates its provider's noun into this shape. Leaking `pullRequest` into a GitLab code path
 * is the beginning of a per-provider domain, which is exactly what this interface exists to
 * prevent.
 */

export type ScmProvider = "github" | "gitlab";

export interface ScmCredential {
  /** Decrypted Personal Access Token. Never logged, never carried past this call (Principle IV). */
  token: string;
  /** Self-hosted GitHub Enterprise / GitLab base URL, or null for the public SaaS host. */
  baseUrl: string | null;
}

/** A repository identified the way its provider names it — "owner/repo", not a local path. */
export type RepoRef = string;

export interface ExternalIssue {
  externalId: string;
  number: number;
  title: string;
  description: string | null;
  state: "open" | "closed";
  url: string;
}

export interface ExternalChangeRequest {
  externalId: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  headRef: string;
  baseRef: string;
  authorLogin: string | null;
}

export interface ExternalBranch {
  name: string;
  isDefault: boolean;
  headSha: string;
  headCommittedAt: string | null;
}

/**
 * A repository the connected token can actually see — what makes linking a *pick* rather than a
 * typed guess. `fullName` is the same "owner/repo" (GitHub) or "namespace/path" (GitLab) string
 * every other method here takes as its `RepoRef`, so the value chosen from a list is exactly the
 * value the rest of the interface expects; no reformatting between the picker and the call.
 */
export interface ExternalRepository {
  fullName: RepoRef;
  /** The last path segment, for a compact label when the namespace is obvious from context. */
  name: string;
  description: string | null;
  defaultBranch: string | null;
  isPrivate: boolean;
  /** The provider's web page for the repository — not a clone URL, which would embed a token. */
  url: string;
}

/**
 * Read-side today. `createChangeRequest` / `comment` / `readChecks` — the write-side #15
 * originally sketched — are deliberately not declared here yet: they belong to issue #71 (push
 * a branch, open a change request), which is separately blocked on issue #7 landing the
 * `(repository, branch)` join key first. Adding them later is a new interface method plus a
 * driver implementation each, not a breaking change to this one.
 */
export interface ChangeProvider {
  readonly provider: ScmProvider;
  /** Verifies the credential actually authenticates, before it is stored as connected. */
  authenticate(credential: ScmCredential): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Every repository this credential can reach, so the UI offers a choice of real repositories
   * instead of a free-text box where a typo becomes a 404 at first sync.
   */
  listRepositories(credential: ScmCredential): Promise<ExternalRepository[]>;
  listIssues(credential: ScmCredential, repo: RepoRef): Promise<ExternalIssue[]>;
  listChangeRequests(credential: ScmCredential, repo: RepoRef): Promise<ExternalChangeRequest[]>;
  listBranches(credential: ScmCredential, repo: RepoRef): Promise<ExternalBranch[]>;
}

/** Thrown by a driver when the provider's API rejects the request outright. */
export class ScmProviderError extends Error {
  constructor(
    readonly provider: ScmProvider,
    message: string,
  ) {
    super(message);
    this.name = "ScmProviderError";
  }
}
