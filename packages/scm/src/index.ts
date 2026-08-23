import type { IntegrationCapability, ProviderManifestDto } from "@gatecontrol/contracts";
import { ProviderRegistry, toManifest } from "@gatecontrol/core";
import { GiteaProvider } from "./gitea.js";
import { GithubProvider } from "./github.js";
import { GitlabProvider } from "./gitlab.js";
import type {
  ChangeRequestsCapability,
  IssuesCapability,
  ProviderDriver,
  RepositoriesCapability,
} from "./types.js";

export { GiteaProvider } from "./gitea.js";
export { GithubProvider } from "./github.js";
export { GitlabProvider } from "./gitlab.js";
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

const baseUrlField = (help: string, placeholder: string, required: boolean) =>
  ({ key: "baseUrl", label: "Base URL", help, placeholder, required, secret: false }) as const;

registry.register({
  id: "github",
  name: "GitHub",
  capabilities: ["issues", "repositories", "changeRequests"],
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
  capabilities: ["issues", "repositories", "changeRequests"],
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
  capabilities: ["issues", "repositories", "changeRequests"],
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
 * `@gatecontrol/core` deliberately does not import. The registry guarantees the *fact*; this
 * states what that fact means in types.
 *
 * It is what replaces "call it and hope" for anything that is not a full source host: ask for
 * issues, get something with `listIssues`, or get nothing.
 */
export type DriverWith<C extends IntegrationCapability> = ProviderDriver &
  (C extends "issues"
    ? IssuesCapability
    : C extends "repositories"
      ? RepositoriesCapability
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
