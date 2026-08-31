import type { IntegrationCapability, ProviderManifestDto } from "@solow/contracts";
import { ISSUE_FIELDS, PROJECT_FIELD_TYPES } from "@solow/contracts";
import { ProviderRegistry, toManifest } from "@solow/core";
import { GiteaProvider } from "./gitea.js";
import { GithubProvider } from "./github.js";
import { GitlabProvider } from "./gitlab.js";
import { GITLAB_FIELD_SUPPORT } from "./gitlab-projects.js";
import type {
  ChangeRequestsCapability,
  IssueCreatesCapability,
  IssuesCapability,
  IssueWritesCapability,
  LabelWritesCapability,
  ProjectsCapability,
  ProviderDriver,
  RepositoriesCapability,
} from "./types.js";

export { GiteaProvider } from "./gitea.js";
export { GithubProvider } from "./github.js";
export { GitlabProvider } from "./gitlab.js";
// The paging bound a caller needs to tell a complete listing from a truncated one (issue #125).
export { ISSUE_PAGE_CAP, ISSUE_PAGE_SIZE } from "./http.js";
export { DEFAULT_LABEL_TAXONOMY } from "./label-taxonomy.js";
export * from "./types.js";

/**
 * Which providers this build has (F21, Decision 0016).
 *
 * This file used to be a four-line `switch`, and that switch was one of eight places a third
 * provider had to be added to. It is now the *only* one: everything else — the settings picker,
 * the source labels on an imported Issue, the https clone username, the connect form's fields —
 * reads what it needs off a manifest, so adding a provider is a driver file and an entry below.
 *
 * Registered here at module load rather than discovered at start-up. Loading a provider from
 * outside this repository is deliberately not part of this: it is a small addition on top of the
 * registry (discover, validate, register) and a large one without, and running a *community*
 * driver is a security question of its own, since a driver holds a Workspace's access tokens.
 * Decision 0016 states both exclusions.
 */

const registry = new ProviderRegistry<ProviderDriver>();

/**
 * The Personal Access Token every provider here authenticates with.
 *
 * Shared because all three take the same one — a single secret field, stored as a `scm_pat`
 * Secret and never read back (Principle IV). A provider that needed an account email beside its
 * token would declare two fields instead, which is the case the manifest exists to allow.
 */
const patField = {
  key: "token",
  label: "Personal access token",
  help: "Stored encrypted, and never shown again once saved.",
  required: true,
  secret: true,
} as const;

/**
 * What a full source host can be asked to change on an issue.
 *
 * This used to be every driver's declaration with an empty `cannot`, and the comment here said
 * the shape was not ceremonial even so. It stopped being hypothetical the moment GitLab's four
 * extra issue fields joined `ISSUE_FIELDS` (user request 2026-08-30): GitHub and Gitea have none
 * of them, and now say so in a sentence apiece rather than failing at the first save. A contract
 * written only for providers that can do everything never finds out that one cannot, which is the
 * mistake Decision 0018 was written about — and this is that discovery, on the issue side.
 */
const GITLAB_ONLY_ISSUE_FIELDS = ["dueDate", "weight", "confidential", "timeEstimate"] as const;

/** Every field this build knows, less the four only GitLab holds. */
const COMMON_ISSUE_FIELDS = ISSUE_FIELDS.filter(
  (f) => !(GITLAB_ONLY_ISSUE_FIELDS as readonly string[]).includes(f),
);

/**
 * The sentence shown where each of the four would have had a control. Written per provider rather
 * than shared, because "GitHub issues have no weight" and "Gitea issues have no weight" are the
 * same shape of fact about two different products, and a reader is owed the name of the one they
 * are actually looking at (F23 FR-5).
 */
const noSuchField = (product: string) =>
  ({
    dueDate: `${product} issues have no due date.`,
    weight: `${product} issues have no weight — it is a GitLab field.`,
    confidential: `${product} issues have no confidential flag.`,
    timeEstimate: `${product} issues carry no time estimate.`,
  }) as const;

const ISSUE_WRITES_WITHOUT_GITLAB_EXTRAS = (product: string) =>
  ({ writes: COMMON_ISSUE_FIELDS, cannot: noSuchField(product) }) as const;

/** GitLab alone writes all of them. */
const FULL_ISSUE_WRITES = { writes: ISSUE_FIELDS, cannot: {} } as const;

const baseUrlField = (help: string, placeholder: string, required: boolean) =>
  ({ key: "baseUrl", label: "Base URL", help, placeholder, required, secret: false }) as const;

registry.register({
  id: "github",
  name: "GitHub",
  capabilities: [
    "issues",
    "issueWrites",
    "repositories",
    "changeRequests",
    "projects",
    "labelWrites",
    "issueCreates",
  ],
  /**
   * Projects v2 expresses every type in the union — which is precisely why it must not be the
   * only driver declaring this. A contract shaped around a provider that can do everything never
   * discovers that another cannot (Decision 0018); GitLab, below, is that discovery.
   */
  projectFields: { expresses: PROJECT_FIELD_TYPES, cannot: {} },
  issueWrites: ISSUE_WRITES_WITHOUT_GITLAB_EXTRAS("GitHub"),
  /**
   * GitHub can create an Issue and has no epics — its own parity concept is the sub-issue, which
   * `parentIssue` below now declares in its own right (spec F23a Part 1).
   * `createEpic`/`listGroups`/`listEpics` still exist on `GithubProvider` (the registry's
   * `CapabilityNotImplemented` check requires it), and each throws a descriptive
   * `ScmProviderError` a caller should never actually reach because `epics: false` is what
   * disables the "New epic" menu entry before it gets the chance.
   */
  issueCreates: {
    epics: false,
    // GitHub's issues carry none of these four as a field of their own: no due date, no weight,
    // no confidential flag and no time estimate (user request 2026-08-30). Declared `false`
    // explicitly rather than left to the schema default, because "we checked and it has none" and
    // "nobody has said" should not look the same in a manifest.
    dueDate: false,
    weight: false,
    confidential: false,
    timeEstimate: false,
    /**
     * It does have links, and they are dependencies: an issue blocks, or is blocked by, another
     * (user request 2026-08-31). It has no "relates to" at all, which `linkTypes` says rather
     * than leaving the form to offer a relation the driver would have to drop.
     */
    links: true,
    linkTypes: ["blocks", "is_blocked_by"],
    /**
     * And three fields GitLab has no equivalent of. Issue types are configured on an organisation
     * (a user-owned repository inherits none, which `listIssueTypes` reports as an empty list
     * rather than an error); the parent is a sub-issue, GitHub's answer to the epic it does not
     * have; the board is a Projects v2 project, which is the `projects` capability's object seen
     * from the create side.
     */
    issueTypes: true,
    parentIssue: true,
    providerProject: true,
  },
  changeRequestNoun: "pull request",
  fields: [
    patField,
    baseUrlField(
      "Only for GitHub Enterprise Server. Leave empty for github.com.",
      "https://github.example.com",
      false,
    ),
  ],
  driver: new GithubProvider(),
});

registry.register({
  id: "gitlab",
  name: "GitLab",
  capabilities: [
    "issues",
    "issueWrites",
    "repositories",
    "changeRequests",
    "projects",
    "labelWrites",
    "issueCreates",
  ],
  /**
   * The declaration that keeps GitLab a first-class provider rather than a degraded GitHub: what
   * a scoped label can carry, and the sentence a person reads where the rest would have been.
   */
  projectFields: GITLAB_FIELD_SUPPORT,
  issueWrites: FULL_ISSUE_WRITES,
  /**
   * GitLab groups are epics (spec F23a Part 1) — the one provider here that has the concept — and
   * a GitLab issue carries four more fields than the universal set plus real issue links (user
   * request 2026-08-30). `weight` is declared here because the *field* exists on every tier; that
   * a free tier ignores it is a tier fact, reported the way `hasWeights` already reports it for
   * the Estimate column rather than by pretending the field is absent.
   */
  issueCreates: {
    epics: true,
    dueDate: true,
    weight: true,
    confidential: true,
    timeEstimate: true,
    links: true,
    /** All three, which is what `links` alone used to mean and still means where it is absent. */
    linkTypes: ["relates_to", "blocks", "is_blocked_by"],
    /**
     * The three GitHub extras, and why not. GitLab's `issue_type` is a fixed product set (issue,
     * incident, test case, task) rather than a vocabulary a group configures, and is not offered
     * on the compose form; its hierarchy is the epic above, not an issue nested under an issue;
     * and it has no project object at all (Decision 0018) to put a new issue on.
     */
    issueTypes: false,
    parentIssue: false,
    providerProject: false,
  },
  changeRequestNoun: "merge request",
  fields: [
    patField,
    baseUrlField(
      "Only for a self-managed instance. Leave empty for gitlab.com.",
      "https://gitlab.example.com",
      false,
    ),
  ],
  driver: new GitlabProvider(),
});

registry.register({
  id: "gitea",
  name: "Gitea",
  capabilities: ["issues", "issueWrites", "repositories", "changeRequests"],
  issueWrites: ISSUE_WRITES_WITHOUT_GITLAB_EXTRAS("Gitea"),
  changeRequestNoun: "pull request",
  fields: [
    patField,
    // Required, unlike the other two: Gitea has no hosted instance to fall back to, so a
    // connection with no host is not a connection.
    baseUrlField("Your Gitea instance.", "https://gitea.example.com", true),
  ],
  driver: new GiteaProvider(),
});

/**
 * The https clone username a provider expects.
 *
 * All three authenticate on the token and ignore this, but sending what each documents costs
 * nothing. It lives beside the registration rather than in a table in the orchestrator, which is
 * where it used to be and where it was one more thing to remember when adding a provider.
 */
const CLONE_USERNAME: Record<string, string> = {
  github: "x-access-token",
  gitlab: "oauth2",
  gitea: "oauth2",
};

/** What to put before the token in an https clone URL. `git` is the conventional fallback. */
export function cloneUsernameFor(provider: string): string {
  return CLONE_USERNAME[provider] ?? "git";
}

/**
 * The driver for a stored `integration.provider` value, or null when nothing registers it.
 *
 * Null rather than a throw, because an unrecognised id is an ordinary state and not a fault: a
 * Workspace can hold rows written by a build that shipped a provider this one does not. Callers
 * turn it into whatever their layer says — a DAL `Result`, an inert badge — and the row stays
 * readable either way (F21 FR-7).
 */
export function providerFor(provider: string): ProviderDriver | null {
  return registry.get(provider)?.driver ?? null;
}

/**
 * What a driver is once it is known to have a capability, and the lookup that proves it.
 *
 * The mapping lives here rather than in the registry because these interfaces name
 * `ExternalIssue`, `ExternalBranch` and the rest — the driver boundary's vocabulary, which
 * `@solow/core` deliberately does not import. The registry guarantees the *fact*; this
 * states what that fact means in types.
 *
 * It is what replaces "call it and hope" for anything that is not a full source host: ask for
 * issues, get something with `listIssues`, or get nothing.
 */
export type DriverWith<C extends IntegrationCapability> = ProviderDriver &
  (C extends "issues"
    ? IssuesCapability
    : C extends "issueWrites"
      ? IssueWritesCapability
      : C extends "repositories"
        ? RepositoriesCapability
        : C extends "projects"
          ? ProjectsCapability
          : C extends "labelWrites"
            ? LabelWritesCapability
            : C extends "issueCreates"
              ? IssueCreatesCapability
              : ChangeRequestsCapability);

export function providerWith<C extends IntegrationCapability>(
  provider: string,
  capability: C,
): DriverWith<C> | null {
  const found = registry.with(provider, capability);
  // The one place this design is taken on trust, and it is discharged at registration:
  // `ProviderRegistry.register` refuses any descriptor whose driver lacks a method its manifest
  // promised, so a descriptor that comes back from `with` provably has them.
  return found ? (found.driver as DriverWith<C>) : null;
}

/** Whether this build can act through a stored provider id at all. */
export function isProviderInstalled(provider: string): boolean {
  return registry.has(provider);
}

/** Every installed provider, or those declaring one capability — what the settings picker lists. */
export function listProviderManifests(capability?: IntegrationCapability): ProviderManifestDto[] {
  return registry.list(capability).map(toManifest);
}

/** The descriptor behind a stored id, for a caller that needs its name or its noun. */
export function providerManifest(provider: string): ProviderManifestDto | null {
  const found = registry.get(provider);
  return found ? toManifest(found) : null;
}

/**
 * Register a provider from a test, and take it out again.
 *
 * Exported because the properties worth testing at this boundary — that an issues-only tracker
 * is excluded from repository pickers, that an orphaned id degrades — need a provider shaped
 * unlike the three above, and inventing one is cheaper and clearer than pretending Jira ships.
 */
export const testing = {
  register: registry.register.bind(registry),
  unregister: registry.unregister.bind(registry),
};
