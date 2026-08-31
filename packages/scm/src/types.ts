import type {
  IssueLinkType,
  ProjectFieldOption,
  ProjectFieldType,
  ProjectFieldValue,
  ProjectIteration,
} from "@solow/contracts";

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
  /**
   * Everything below is a **read-only mirror** (spec F23 FR-8, issue #122 AC-2).
   *
   * None of it is SoloW's to author: assignees, labels and hierarchy belong to the
   * provider, and a planning table that let you edit them here would be editing a copy. They are
   * carried because a row that cannot show who holds an issue is not a planning row — and
   * because fetching them per row, on render, is what a mirror exists to avoid.
   *
   * Every one is optional. A driver that cannot answer omits the field rather than inventing an
   * empty answer, so "nobody is assigned" stays distinguishable from "this provider does not
   * report assignees".
   */
  assignees?: ExternalUser[];
  labels?: string[];
  milestone?: ExternalMilestone | null;
  /**
   * The four GitLab-only fields, read back so an editor opens on what the provider actually holds
   * rather than on a blank control (user request 2026-08-30). Optional under the same rule as
   * everything else here: a driver that cannot answer omits the key, so "no due date" stays
   * distinguishable from "this provider does not have due dates".
   */
  dueDate?: string | null;
  weight?: number | null;
  confidential?: boolean;
  /** The provider's own rendering of the estimate ("2h"), not a second of raw seconds. */
  timeEstimate?: string | null;
  /**
   * The parent issue or epic, for the hierarchy the table nests by.
   *
   * Three states, and the mirror writes a different thing for each: a string nests the row,
   * `null` un-nests it because the provider said there is no parent, and **absent** means the
   * provider was not able to say — an older self-hosted instance, a tier without epics, a
   * failed side call. Only the second may erase an edge; treating absence as "no parent" would
   * un-nest every row on a provider that simply does not report hierarchy.
   *
   * The id is in the same space as `externalId`, because that is what resolves it: a parent is
   * matched against the other rows' own ids. A driver whose provider names parents in a
   * different space says so in that space, and never in one where an unrelated issue could
   * answer to the same number.
   */
  parentExternalId?: string | null;
  /**
   * Pull or merge requests the provider itself links to this issue.
   *
   * Only populated when the caller asked for it (`ListIssuesOptions.linkedChangeRequests`) —
   * every provider reports links per issue rather than per listing, so this field costs one
   * request per row and nothing else here does.
   */
  linkedChangeRequests?: ExternalLinkedChange[];
  /** When the provider last changed it — the cursor an incremental sync pages on. */
  updatedAt?: string;
}

/** A person, as much of one as a planning table needs. */
export interface ExternalUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * One comment on an issue.
 *
 * Deliberately not "one timeline entry". GitLab returns *notes*, and most of them are the system
 * recording that somebody changed a label or moved a milestone; GitHub keeps that in a separate
 * timeline entirely. A driver filters its provider's activity out, so this type means the same
 * thing on both: something a person wrote.
 */
export interface ExternalComment {
  externalId: string;
  /** Who wrote it. Null where the provider reports an author it will not name (a bot, a ghost). */
  author: ExternalUser | null;
  /** The raw Markdown, rendered by the client — never HTML from the provider. */
  body: string;
  createdAt: string;
  /** Set only when the comment was edited after posting; null otherwise. */
  updatedAt: string | null;
  url: string;
}

export interface ExternalMilestone {
  externalId: string;
  title: string;
  /** GitLab milestones carry dates; GitHub's carry a due date only. Null where absent. */
  startDate: string | null;
  dueDate: string | null;
}

/** A change request the provider links to an issue, as much as a badge needs. */
export interface ExternalLinkedChange {
  externalId: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  mergedAt: string | null;
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
 * What one issue listing is being asked for — and, the part that matters, what it is willing to
 * pay the provider for.
 *
 * An options object rather than a second method, deliberately. The enrichment is one extra
 * request *per issue*, and both the fan-out and the concurrency window that keeps it under a
 * provider's secondary rate limit are provider knowledge: a separate
 * `listLinkedChangeRequests(repo, issueNumber)` would hand every caller that wanted the column a
 * loop to write and a limit to guess at, and the first one to use `Promise.all` would lose a
 * whole repository's sync to a throttle. Asking for the same list with more on it keeps that
 * decision where the provider's rules are known.
 */
export interface ListIssuesOptions {
  /**
   * An ISO timestamp the provider filters on — "changed after this".
   *
   * Optional because the manual import (F01) wants everything, and load-bearing because the
   * automatic sync (issue #125) runs every few minutes: re-reading a repository's whole history
   * on each pass is what exhausts a rate limit, and a watermark is the only thing that turns a
   * poll into an incremental read. A driver whose provider offers no such filter ignores it and
   * returns everything — correct, just not cheap.
   */
  since?: string;
  /**
   * Also read the change requests the provider links to each issue — **off by default**.
   *
   * It was unconditional, and that made every caller pay for a column only the planning table
   * reads: connecting an Integration auto-imports issues from every repository the token can
   * see, and each of those listings fanned out one request per issue to fill a field it then
   * threw away. A hundred-issue repository cost a hundred and one requests to answer "which
   * issues exist".
   */
  linkedChangeRequests?: boolean;
}

/**
 * The `issues` capability: work items and the vocabulary they are tagged with.
 *
 * `RepoRef` is what the provider calls the container an issue lives in — "owner/repo" on a
 * source host, a project key on a tracker. Naming it after the source host's shape is a
 * historical accident of GitHub being first, and it is only a string.
 */
export interface IssuesCapability {
  listIssues(
    credential: ScmCredential,
    repo: RepoRef,
    options?: ListIssuesOptions,
  ): Promise<ExternalIssue[]>;
  /**
   * One issue, in full.
   *
   * A listing drops assignees, labels and the milestone — deliberately, because a hundred-issue
   * page does not need them and `ExternalIssue` keeps "absent" distinguishable from "empty". An
   * editor is the opposite case: it needs exactly those, for one issue, current at the moment it
   * opened. Reading them out of the mirror instead would show a form built from whatever the last
   * poll happened to store.
   */
  getIssue(credential: ScmCredential, repo: RepoRef, issueNumber: number): Promise<ExternalIssue>;
  /**
   * The comments on one issue, oldest first.
   *
   * Reading, so it lives with `issues` rather than with `issueWrites`: a read-only mirror of a
   * tracker should still be able to show the discussion, and a token that cannot post is not a
   * token that cannot read.
   */
  listComments(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
  ): Promise<ExternalComment[]>;
  /** The container's own labels, for the Issue label picker (issue #15 reversal). */
  listLabels(credential: ScmCredential, repo: RepoRef): Promise<ExternalLabel[]>;
}

/**
 * A change to an issue, as a patch: a key that is **absent is not being changed**.
 *
 * Absent and null are different answers, and both are meaningful here — `milestone: null` clears
 * the milestone, `milestone` absent leaves whatever is there. An editor that sent its whole form
 * every time would silently overwrite the fields it did not display, which is how a second client
 * quietly reverts a colleague's edit.
 */
export interface IssuePatch {
  title?: string;
  description?: string | null;
  state?: "open" | "closed";
  /** Provider logins. An empty array un-assigns everyone; absent leaves the assignees alone. */
  assignees?: string[];
  /** Label names, replacing the set. Empty clears them. */
  labels?: string[];
  /** The provider's own milestone id, or null to clear it. */
  milestone?: string | null;
  /**
   * The four GitLab-only fields (user request 2026-08-30). Each follows this file's absent-vs-null
   * rule exactly as the ones above do: absent leaves it alone, `null` clears it, a value sets it.
   * A caller decides whether to send one by reading the provider's `issueWrites` manifest, never
   * its name — and on GitHub and Gitea the manifest's `cannot` map is what the editor renders
   * instead of a control.
   */
  /** ISO `YYYY-MM-DD`, or null to clear the due date. */
  dueDate?: string | null;
  /** A whole number, or null to clear the weight. */
  weight?: number | null;
  confidential?: boolean;
  /** A duration in the provider's own grammar ("2h"), or null to clear the estimate. */
  timeEstimate?: string | null;
}

/**
 * The `issueWrites` capability: changing an issue on the provider that owns it.
 *
 * Every method answers with **what the provider now holds**, never an acknowledgement — the same
 * rule `writeProjectFieldValue` follows and for the same reason (F23 NFR-7). A provider may
 * normalise a title, refuse an assignee who has no access, or drop a label that does not exist;
 * rendering back what was typed would show the operator their own input as though it were stored.
 */
export interface IssueWritesCapability {
  updateIssue(
    credential: ScmCredential,
    repo: RepoRef,
    /** The issue's number *within its container* — GitHub's `number`, GitLab's `iid`. */
    issueNumber: number,
    patch: IssuePatch,
  ): Promise<ExternalIssue>;
  /**
   * Who may be assigned here.
   *
   * A list from the provider rather than a free-text login box: assigning someone with no access
   * is refused by every provider, and a picker that offers the refusal is a picker that lies.
   */
  listAssignableUsers(credential: ScmCredential, repo: RepoRef): Promise<ExternalUser[]>;
  listMilestones(credential: ScmCredential, repo: RepoRef): Promise<ExternalMilestone[]>;
  /**
   * Post a comment, and answer with **what the provider stored** — never the text that was sent.
   *
   * The same rule every write here follows: a provider may normalise the body, and rendering back
   * what was typed would show the operator their own input as though it were saved.
   */
  createComment(
    credential: ScmCredential,
    repo: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<ExternalComment>;
}

/** One label to create, in the shape every provider here takes it. */
export interface LabelSeed {
  name: string;
  /** `#RRGGBB` — the same normalized shape `ExternalLabel.color` reads back (issue #15 reversal). */
  color: string;
  description?: string;
}

/**
 * The `labelWrites` capability: create the labels a repository does not have yet (user request
 * 2026-08-27).
 *
 * Its own capability rather than folded into `issueWrites` — a provider can write an issue's
 * fields without being able to create new vocabulary for them, and the manifest should be able to
 * say so. GitHub and GitLab both declare it; a tracker with no label-creation endpoint at all
 * simply does not.
 */
export interface LabelWritesCapability {
  /**
   * Create every label in `labels` the repository does not already have, leaving existing ones —
   * whatever their colour or description — exactly as they are. Matching is case-insensitive,
   * the same rule GitLab's own scoped-label provisioning already follows, because two labels
   * differing only in case is not a distinction any of these providers themselves make.
   *
   * Answers with what it created and what was already there, the same
   * `ProjectStructureProvisioned` shape `provisionProjectStructure` reports back with — one
   * report shape for "here is the structure I made sure exists" everywhere this codebase does it.
   */
  createLabels(
    credential: ScmCredential,
    repo: RepoRef,
    labels: LabelSeed[],
  ): Promise<ProjectStructureProvisioned>;
}

/** One issue to create, in the shape every provider here takes it. */
export interface IssueSeed {
  title: string;
  description?: string;
  /** Provider logins. Resolved to whatever the provider assigns by internally (GitLab's numeric ids). */
  assignees?: string[];
  labels?: string[];
  /** The provider's own milestone id — the same value `ExternalMilestone.externalId` carries. */
  milestone?: string;
  /**
   * The epic this issue is created under — GitLab only. A GitHub caller simply never sends it,
   * the same "ask the manifest, never the provider's name" rule that keeps `epicParentId` out of
   * the domain vocabulary on the read side (Decision 0016).
   */
  parentEpicId?: string;
  /**
   * The optional fields below are each gated by a flag on the provider's `issueCreates` manifest
   * (`IssueCreateSupport`), so a caller decides whether to send one by asking what the provider
   * declares, never by branching on its name (Decision 0016). Absent means "the provider decides",
   * exactly as it does for the fields above.
   */
  /** ISO `YYYY-MM-DD`. A due date only — an issue has no start date on GitLab (Decision 0018). */
  dueDate?: string;
  /** A whole number; what it means is the provider's business (GitLab: issue weight). */
  weight?: number;
  /** Visible only to members. Absent leaves the provider's default, which is public. */
  confidential?: boolean;
  /**
   * An up-front estimate in the provider's own duration grammar (`"2h"`, `"3d"`), passed through
   * verbatim rather than parsed to seconds here: the grammar is the provider's, and every one of
   * them rejects a duration it cannot read with a better message than this layer could invent.
   */
  timeEstimate?: string;
  /** Existing issues to link the new one to, by the provider's own issue reference. */
  links?: IssueSeedLink[];
  /**
   * The three below are the same arrangement seen from the other provider: fields GitHub's issues
   * carry and GitLab's do not, each gated by its own `issueCreates` flag. Nothing about them is
   * GitHub-shaped at this boundary — a tracker with issue types and a parent issue would fill
   * them in exactly the same way.
   */
  /**
   * The provider's own name for an issue type ("Bug", "Feature", "Task"), passed through verbatim.
   * The name rather than an id because that is what the create endpoint reads, and because a name
   * is the thing the picker showed the person who chose it.
   */
  issueType?: string;
  /**
   * Nest the new issue under this existing one, by its number within the same repository — the
   * `number`/`iid` distinction `IssueSeedLink` already draws. Separate from `parentEpicId`: an
   * epic is another object in another container, this is an ordinary issue in this one.
   */
  parentIssueNumber?: number;
  /** Put the new issue on this provider project board — the id `ExternalProject.externalId` carries. */
  providerProjectId?: string;
}

/**
 * One type a provider lets an issue be given — GitHub's organisation-defined issue types.
 *
 * Not every provider has the concept, and on GitHub not every repository does either: types are
 * configured on an organisation, so a user-owned repository has none. Both cases answer with an
 * empty list rather than an error, because "this repository offers no types" is a fact about the
 * repository and not a failure to read it.
 */
export interface ExternalIssueType {
  externalId: string;
  /** What `IssueSeed.issueType` carries back — the provider takes the type by name. */
  name: string;
  description: string | null;
  color: string | null;
}

/** One link to create alongside a new Issue — see `IssueSeed.links`. */
export interface IssueSeedLink {
  /** The other issue's number within its container — GitHub's `number`, GitLab's `iid`. */
  issueNumber: number;
  type: IssueLinkType;
}

/**
 * One epic to create, in the shape every provider that has them takes it.
 *
 * Specific to the *group* container: an epic has dates of its own, which is what distinguishes it
 * from the other shape a parent planning item comes in. Where a provider's parent item lives in a
 * repository it is an ordinary issue and is seeded with an `IssueSeed` — see
 * `IssueCreatesCapability.createParentPlanningItem`.
 */
export interface EpicSeed {
  title: string;
  description?: string;
  labels?: string[];
  /**
   * `undefined` leaves the provider's default (GitLab computes an epic's dates from its
   * milestones unless told otherwise); `null` clears a date that was set; a string fixes it.
   * Three states for the same reason `IssuePatch` distinguishes absent from null throughout this
   * file: a caller that always sent both dates would pin every epic to a fixed date it never
   * meant to set.
   */
  startDate?: string | null;
  dueDate?: string | null;
}

/**
 * A GitLab epic, mirrored (F23a). The neutral domain calls this "a parent planning item" —
 * GitLab is the only provider with the noun, the same way GitHub is the only one with "pull
 * request" — but the *type* stays named for what it is at the driver boundary, where the
 * translation actually happens; `ExternalIssue.parentExternalId` is where a caller sees the
 * neutral shape.
 *
 * Which is not to say a parent planning item is always one of these: on a provider whose parent
 * lives in a repository it is an `ExternalIssue` and nothing else (`createParentPlanningItem`).
 * This type is what the group container answers with, not what "parent" means.
 */
export interface ExternalEpic {
  externalId: string;
  /** The epic's number within its group — GitLab's `iid`, the same distinction `ExternalIssue.number` draws. */
  iid: number;
  title: string;
  url: string;
  state: "open" | "closed";
  startDate: string | null;
  dueDate: string | null;
  /** The group this epic lives in, in the same space `listGroups` and `createEpic` take. */
  groupRef: string;
}

/**
 * A GitLab group the connected token can create an epic in — what makes the epic "Where" modal
 * a *pick* rather than a typed guess, the same reason `ExternalRepository` exists for repositories.
 */
export interface ExternalGroup {
  externalId: string;
  /** URL-encoded the same way `RepoRef` is — a nested group ("acme/platform") is one path. */
  fullPath: string;
  name: string;
  url: string;
}

/**
 * The `issueCreates` capability: posting a brand-new Issue, a brand-new Epic where the provider
 * has the concept, and — on every provider that can originate one at all — the parent planning
 * item other work items nest under (spec F23a).
 *
 * Those last two are two methods rather than one because they are two objects in two kinds of
 * container: an epic lives in a *group* and has dates of its own, a repository-container parent is
 * an ordinary issue whose parent-ness is entirely the edges its children draw to it. Which of them
 * a caller may reach is the manifest's answer — `issueCreates.epics` for the first,
 * `issueCreates.parentPlanningItem.container` for the second — and a provider may declare either,
 * both or neither.
 *
 * Its own capability rather than folded into `issueWrites`, for the same reason `LabelWritesCapability`
 * is separate from `issueWrites`: a provider can edit an issue it did not create without being able
 * to originate one — the endpoints are different permissions on every provider here, and a token
 * scoped to "update issues" is a real, common case this must not silently promise more than.
 * Folding it in would also make the epic methods unexpressible for GitHub, which can write an
 * issue's fields but has no group object to create one in at all.
 *
 * `createIssue`/`createEpic` answer with **what the provider now holds**, never an
 * acknowledgement — the same rule every write in this file follows (F23 NFR-7): a provider may
 * normalise a title, silently drop an assignee with no access, or reject a label that does not
 * exist, and rendering back what was typed would show the operator their own input as though it
 * were stored.
 */
export interface IssueCreatesCapability {
  /** POST a new issue, and answer with what the provider stored. */
  createIssue(credential: ScmCredential, repo: RepoRef, seed: IssueSeed): Promise<ExternalIssue>;
  /**
   * Create an epic in a group. Not every provider that creates issues can create epics — GitHub
   * has none — which is exactly what the manifest's `issueCreates.epics` flag exists to say
   * before a caller ever reaches this method (spec F23a Part 1, "GitHub declares
   * `issueCreates.epics = false`").
   */
  createEpic(credential: ScmCredential, groupRef: string, seed: EpicSeed): Promise<ExternalEpic>;
  /**
   * Originate, **in a repository**, the item other work items nest under — for a provider whose
   * manifest declares `parentPlanningItem.container === "repository"` (user request 2026-08-31).
   *
   * It answers with an `ExternalIssue`, and takes an `IssueSeed`, because on such a provider the
   * parent genuinely *is* an issue in a container: it has a number, a URL and a state, and the
   * only thing that makes it a parent is that other issues name it (GitHub's sub-issues, written
   * by `IssueSeed.parentIssueNumber` and read back as `ExternalIssue.parentExternalId`). Inventing
   * a third object type here would give the domain a second hierarchy to reconcile against the one
   * it already has.
   *
   * A provider whose container is `"group"` still implements this — the registry checks every
   * method a declared capability names — and answers the way `createEpic` does on GitHub: with a
   * sentence. Silently creating a plain issue instead would be a write that reports success and
   * produces the wrong object.
   */
  createParentPlanningItem(
    credential: ScmCredential,
    repo: RepoRef,
    seed: IssueSeed,
  ): Promise<ExternalIssue>;
  /** Groups the token can create an epic in — the epic "Where" modal's picker. */
  listGroups(credential: ScmCredential): Promise<ExternalGroup[]>;
  /** Existing epics in a group, for the "parent epic" picker on the issue-create form. */
  listEpics(credential: ScmCredential, groupRef: string): Promise<ExternalEpic[]>;
  /**
   * The issue types this repository offers, for the type picker on the compose form.
   *
   * Empty, never an error, where the repository has none — a GitHub repository owned by a person
   * rather than an organisation is the ordinary case, not a broken one. A provider whose manifest
   * declares `issueCreates.issueTypes: false` is never asked; it still implements this (the
   * registry checks every method a manifest's capability names exists) and answers the way
   * `createEpic` does on a provider without epics, with a sentence rather than a silent empty
   * list that would read as "this repository happens to have none".
   */
  listIssueTypes(credential: ScmCredential, repo: RepoRef): Promise<ExternalIssueType[]>;
}

/** The `repositories` capability: what can be cloned, and what branches it has. */
export interface RepositoriesCapability {
  /**
   * Every repository this credential can reach, so the UI offers a choice of real repositories
   * instead of a free-text box where a typo becomes a 404 at first sync.
   */
  listRepositories(credential: ScmCredential): Promise<ExternalRepository[]>;
  /**
   * One repository by its full name — including one the account does not own.
   *
   * `listRepositories` answers "what could I connect?", which is a different question: it is a
   * page of the *account's* repositories. A project row can point at an issue in a repository
   * outside that page entirely (another org, a public repository the operator only collaborates
   * on), and connecting it needs the clone URL, which only the provider can give.
   *
   * Null when the repository does not exist or the token cannot see it — the two are deliberately
   * one answer, because a provider reports them as one (a 404 for both) and guessing which would
   * be inventing detail.
   */
  getRepository(credential: ScmCredential, repo: RepoRef): Promise<ExternalRepository | null>;
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
 * The `projects` capability (spec F23, Decision 0018, issue #122).
 *
 * The one capability whose *shape* differs per provider rather than only its presence. GitHub
 * Projects v2 holds arbitrary typed fields; GitLab holds scoped labels, and on paid tiers only,
 * iterations and weights. So a driver declaring this capability also declares, in its manifest,
 * which field types it can express and the reason for each it cannot — and callers ask the
 * manifest, never the provider's name.
 */
export interface ProjectsCapability {
  /** The projects this credential can see, for the picker that adopts one. */
  listProjects(credential: ScmCredential): Promise<ExternalProject[]>;
  /** A project's column set, with each field's type and whether this provider can hold it. */
  readProjectFields(
    credential: ScmCredential,
    projectExternalId: string,
  ): Promise<ExternalProjectField[]>;
  /**
   * One page of a project's rows.
   *
   * Paged with an opaque cursor the driver mints, stored on `project.sync_cursor`, so a sync
   * interrupted halfway resumes where it stopped rather than re-reading a 2000-item project from
   * the top (Principle III).
   */
  readProjectItems(
    credential: ScmCredential,
    projectExternalId: string,
    cursor: string | null,
  ): Promise<ExternalProjectItemPage>;
  /**
   * Write one field value, and answer with **what the provider now holds** — not an
   * acknowledgement (issue #122 AC-3).
   *
   * The difference decides whether the table can be honest. A provider may normalise, refuse
   * part of a value, or hold something subtly different from what was sent; rendering the value
   * that was typed would show the operator their own input as though it were stored. Returning
   * the stored value means the cell always shows what is actually there (F23 FR-4, NFR-7).
   */
  writeProjectFieldValue(
    credential: ScmCredential,
    write: ProjectFieldWrite,
  ): Promise<ExternalProjectValue>;
  /**
   * Make sure the provider can *hold* a project's structure, creating what it cannot.
   *
   * The method that only exists because GitLab has no project object. GitHub Projects v2 arrives
   * with its fields already defined, so its implementation reports that there was nothing to do;
   * GitLab's creates the scoped labels that stand in for those fields (Decision 0018).
   *
   * Called unconditionally by the adopt flow, never behind a check on which provider this is —
   * "ask for a capability, never for a provider" (Decision 0016) applies to a no-op as much as to
   * real work, and a caller that branched here would be the ninth branch F21 removed eight of.
   *
   * **Never destructive.** A structure element that already exists is left exactly as it is,
   * whatever its colour or description: this creates what is missing and touches nothing else.
   */
  provisionProjectStructure(
    credential: ScmCredential,
    projectExternalId: string,
  ): Promise<ProjectStructureProvisioned>;
}

/** What a provisioning pass created, so it can be reported after the fact. */
export interface ProjectStructureProvisioned {
  /** Names of the structure elements this pass created. Empty when there was nothing to do. */
  created: string[];
  /** Elements that were already there and were deliberately left alone. */
  existing: string[];
}

export interface ExternalProject {
  externalId: string;
  title: string;
  url: string;
  /**
   * The user or organization the project belongs to, where the provider says.
   *
   * Two organizations each with a "Roadmap" are indistinguishable in a picker without it, and
   * adopting the wrong one is a mistake nothing later would surface. Null where the provider has
   * no notion of an owner distinct from the connection.
   */
  ownerLogin?: string | null;
}

/**
 * A column, as the provider describes it.
 *
 * `type` is already translated into the product's closed union at the driver — a provider type
 * with no member there arrives as `text`, `readOnly`, named as the provider names it, which is
 * how the column set stays honest about what the project holds rather than hiding what it cannot
 * render (F23, States & rules).
 */
export interface ExternalProjectField {
  externalId: string;
  name: string;
  type: ProjectFieldType;
  options: ProjectFieldOption[];
  iterations: ProjectIteration[];
  position: number;
  readOnly: boolean;
  /** Prose, shown to the operator where the input would have been. Null when it is editable. */
  readOnlyReason: string | null;
}

export interface ExternalProjectValue {
  fieldExternalId: string;
  /** Already in the product's shape; `parseProjectFieldValue` reads it back against the field. */
  value: ProjectFieldValue | null;
}

export interface ExternalProjectItem {
  externalId: string;
  /** The issue this row is. A row with no issue behind it (a Projects v2 draft) is omitted. */
  issueExternalId: string;
  position: number;
  archivedAt: string | null;
  values: ExternalProjectValue[];
  /**
   * The issue itself, when the provider hands it over with the row.
   *
   * A project is precisely the thing that spans repositories, and most of the ones it spans are
   * not connected to this Workspace. Without this, such a row can never resolve to an Issue and
   * is skipped on every pass for ever — a table with columns and no rows, reporting a count that
   * reads like a race rather than a permanent mismatch. Carrying the issue lets the mirror
   * *create* what it is missing instead of waiting for something that will never arrive.
   *
   * Optional, because a provider that cannot report it in the same call should say so by omitting
   * it rather than by returning a half-built issue. Where it is absent the old behaviour stands:
   * the row waits for the repository sync.
   */
  issue?: ExternalProjectItemIssue;
}

/** An issue carried alongside a project row, with the repository needed to connect it. */
export interface ExternalProjectItemIssue extends ExternalIssue {
  /** "owner/repo" — what a Repository row stores as `externalFullName`. */
  repositoryFullName: RepoRef;
}

export interface ExternalProjectItemPage {
  items: ExternalProjectItem[];
  /** Null when the walk is finished — which is what clears `project.sync_cursor`. */
  nextCursor: string | null;
  /**
   * Rows that exist on the provider but are not issues, counted rather than discarded.
   *
   * Every row in SoloW is an Issue (F23, Out of scope), so a Projects v2 draft card and a
   * pull-request row both have to go. Silently is the one way they must not go: a table shorter
   * than the same project on GitHub, with nothing to explain the difference, is indistinguishable
   * from a broken import. Counting them lets the mirror say "12 rows, 3 drafts not shown".
   */
  drafts: number;
  pullRequests: number;
}

export interface ProjectFieldWrite {
  projectExternalId: string;
  itemExternalId: string;
  fieldExternalId: string;
  /** Null clears the cell, which every provider distinguishes from an empty value. */
  value: ProjectFieldValue | null;
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
    Partial<
      IssuesCapability &
        IssueWritesCapability &
        RepositoriesCapability &
        ChangeRequestsCapability &
        ProjectsCapability &
        LabelWritesCapability &
        IssueCreatesCapability
    > {}

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
