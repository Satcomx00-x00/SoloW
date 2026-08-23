/**
 * The provider driver boundary (issue #15, split by capability in F21).
 *
 * Terminology stays neutral in the domain (issue #15's explicit rule): GitHub has pull
 * requests, GitLab has merge requests — the domain says **change request**, and each driver
 * translates its provider's noun into this shape. Leaking `pullRequest` into a GitLab code path
 * is the beginning of a per-provider domain, which is exactly what this boundary exists to
 * prevent.
 *
 * It was one interface with six methods, on the assumption that a provider answers all of them.
 * GitHub, GitLab and Gitea do. A tracker like Jira does not — it has issues and labels and no
 * repositories, branches or change requests at all — and a flat interface leaves it two bad
 * options: implement four methods that throw, or stay unsupported. So the interface is split
 * along the lines the providers themselves fall on, and a provider declares which pieces it
 * supplies (Decision 0016).
 *
 * `authenticate` is the exception that stays universal: a provider you cannot authenticate
 * against is not a provider, whatever else it can do.
 */

/**
 * The provider id, as a driver knows it. A plain string rather than a union: which providers
 * exist is the registry's answer, not this file's, and re-declaring the set here would put back
 * one of the eight places F21 removed.
 */
export type ScmProvider = string;

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
 * A label the repository already carries on its provider (issue #15 reversal — the Issue label
 * picker fetches these instead of asking a user linked to GitHub/GitLab to retype tags that
 * already exist). `color` is normalized to `#RRGGBB` at the driver boundary — GitHub returns it
 * unprefixed, GitLab already prefixed — so every caller gets one consistent swatch format.
 */
export interface ExternalLabel {
  name: string;
  color: string | null;
  description: string | null;
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
  /** The provider's web page for the repository — for a human to open, not for git. */
  url: string;
  /**
   * The https URL git clones from, exactly as the provider reports it and with no credential in
   * it. Importing a repository stores this as its location, so a private repository is cloned by
   * authenticating the request — never by embedding a token in a URL that would then live in the
   * database and in every `git remote -v` (Principle IV).
   */
  cloneUrl: string;
}

/**
 * The `issues` capability: work items and the vocabulary they are tagged with.
 *
 * `RepoRef` is what the provider calls the container an issue lives in — "owner/repo" on a
 * source host, a project key on a tracker. Naming it after the source host's shape is a
 * historical accident of GitHub being first, and it is only a string.
 */
export interface IssuesCapability {
  listIssues(credential: ScmCredential, repo: RepoRef): Promise<ExternalIssue[]>;
  /** The container's own labels, for the Issue label picker (issue #15 reversal). */
  listLabels(credential: ScmCredential, repo: RepoRef): Promise<ExternalLabel[]>;
}

/** The `repositories` capability: what can be cloned, and what branches it has. */
export interface RepositoriesCapability {
  /**
   * Every repository this credential can reach, so the UI offers a choice of real repositories
   * instead of a free-text box where a typo becomes a 404 at first sync.
   */
  listRepositories(credential: ScmCredential): Promise<ExternalRepository[]>;
  listBranches(credential: ScmCredential, repo: RepoRef): Promise<ExternalBranch[]>;
}

/**
 * The `changeRequests` capability.
 *
 * Read-side today. `createChangeRequest` / `comment` / `readChecks` — the write-side #15
 * originally sketched — belong to issue #71 (push a branch, open a change request), which is
 * separately blocked on issue #7 landing the `(repository, branch)` join key first. Adding them
 * later grows this interface and the drivers that declare it; it does not touch a provider that
 * never claimed the capability.
 */
export interface ChangeRequestsCapability {
  listChangeRequests(credential: ScmCredential, repo: RepoRef): Promise<ExternalChangeRequest[]>;
}

/**
 * What every driver has, plus whatever capabilities it declares.
 *
 * The capability methods are optional *on this type* and mandatory in fact: the registry refuses
 * a manifest promising a capability whose methods are missing, and hands callers a driver
 * narrowed to the capability they asked for. So a caller never sees an optional method — it
 * either resolved a provider that has it, or it resolved nothing.
 */
export interface ProviderBase {
  readonly provider: ScmProvider;
  /** Verifies the credential actually authenticates, before it is stored as connected. */
  authenticate(credential: ScmCredential): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ProviderDriver
  extends ProviderBase,
    Partial<IssuesCapability & RepositoriesCapability & ChangeRequestsCapability> {}

/**
 * The old name for a driver that happens to do everything — GitHub, GitLab and Gitea all are
 * one. Kept because it reads well at a call site that genuinely wants a full source host, and
 * because it is what the existing drivers declare.
 */
export interface ChangeProvider
  extends ProviderBase,
    IssuesCapability,
    RepositoriesCapability,
    ChangeRequestsCapability {}

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
