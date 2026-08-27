import { describe, expect, it } from "bun:test";
import { ProviderRegistry, ProviderRegistryErrorCode, toManifest } from "./integrations.js";

/**
 * The integration provider registry (F21).
 *
 * The properties worth holding onto are the ones that used to be guaranteed by a `z.enum` and
 * now have to be guaranteed by this: that resolving a provider is deterministic, that a
 * capability nobody declares yields nothing rather than something that throws, and that a driver
 * lying about what it implements is caught at registration instead of when an Owner presses
 * Import.
 */

interface FakeDriver {
  authenticate(): Promise<{ ok: true }>;
  listIssues?(): Promise<string[]>;
  getIssue?(): Promise<string>;
  listComments?(): Promise<string[]>;
  createComment?(): Promise<string>;
  listLabels?(): Promise<string[]>;
  listRepositories?(): Promise<string[]>;
  getRepository?(): Promise<string | null>;
  listBranches?(): Promise<string[]>;
  listChangeRequests?(): Promise<string[]>;
}

const forge = (over: Partial<FakeDriver> = {}): FakeDriver => ({
  authenticate: async () => ({ ok: true }),
  listIssues: async () => [],
  getIssue: async () => "",
  listComments: async () => [],
  createComment: async () => "",
  listLabels: async () => [],
  listRepositories: async () => [],
  getRepository: async () => null,
  listBranches: async () => [],
  listChangeRequests: async () => [],
  ...over,
});

/** A driver that claims more than it has — the mistake registration is there to catch. */
function withoutRepositories(): FakeDriver {
  const { listRepositories, ...rest } = forge();
  return rest;
}

/** A full source host: everything GitHub and GitLab do. */
const sourceHost = (id: string) => ({
  id,
  name: id,
  capabilities: ["issues", "repositories", "changeRequests"] as const,
  fields: [],
  driver: forge(),
});

/** A tracker: issues and nothing else — the shape a flat interface could not express. */
const tracker = (id: string) => ({
  id,
  name: id,
  capabilities: ["issues"] as const,
  fields: [],
  driver: {
    authenticate: async () => ({ ok: true as const }),
    listIssues: async () => [],
    getIssue: async () => "",
    listComments: async () => [],
    listLabels: async () => [],
  },
});

describe("register", () => {
  it("refuses an id that is not a legal provider id", () => {
    const registry = new ProviderRegistry<FakeDriver>();
    const result = registry.register({ ...sourceHost("Git Hub"), id: "Git Hub" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ProviderRegistryErrorCode.InvalidId);
  });

  it("refuses `local`, which is the absence of a provider", () => {
    const registry = new ProviderRegistry<FakeDriver>();
    const result = registry.register(sourceHost("local"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ProviderRegistryErrorCode.ReservedId);
  });

  it("keeps the registration already in place when an id is claimed twice", () => {
    // Preferring the newcomer would make behaviour depend on module load order — the thing a
    // registry exists to remove.
    const registry = new ProviderRegistry<FakeDriver>();
    const first = { ...sourceHost("gitea"), name: "First" };
    registry.register(first);
    const result = registry.register({ ...sourceHost("gitea"), name: "Second" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ProviderRegistryErrorCode.DuplicateId);
    expect(registry.get("gitea")?.name).toBe("First");
  });

  it("refuses a manifest that promises a capability the driver has not implemented", () => {
    // The whole value of declaring a capability. Caught here, this is a driver bug found at
    // start-up; caught at the call, it looks to an Owner like the provider is down.
    const registry = new ProviderRegistry<FakeDriver>();
    const result = registry.register({
      id: "half",
      name: "Half",
      capabilities: ["issues", "repositories"],
      fields: [],
      // A driver whose manifest promises repositories and whose class forgot to implement them.
      driver: withoutRepositories(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ProviderRegistryErrorCode.CapabilityNotImplemented);
    expect(registry.get("half")).toBeNull();
  });
});

describe("resolving", () => {
  function seeded() {
    const registry = new ProviderRegistry<FakeDriver>();
    registry.register(sourceHost("gitlab"));
    registry.register(sourceHost("github"));
    registry.register(tracker("jira"));
    return registry;
  }

  it("lists providers by id, not by the order modules happened to load in", () => {
    expect(
      seeded()
        .list()
        .map((p) => p.id),
    ).toEqual(["github", "gitlab", "jira"]);
  });

  it("narrows a list to the providers that can actually do the thing", () => {
    const registry = seeded();
    expect(registry.list("issues").map((p) => p.id)).toEqual(["github", "gitlab", "jira"]);
    // The tracker is absent from both of these, and that is the point: a Repository picker that
    // offered Jira would be offering something with no repositories behind it.
    expect(registry.list("repositories").map((p) => p.id)).toEqual(["github", "gitlab"]);
    expect(registry.list("changeRequests").map((p) => p.id)).toEqual(["github", "gitlab"]);
  });

  it("returns nothing for a capability no installed provider declares", () => {
    const registry = new ProviderRegistry<FakeDriver>();
    registry.register(tracker("jira"));
    expect(registry.list("repositories")).toEqual([]);
  });

  it("gives a caller a driver only when the provider claims that capability", () => {
    const registry = seeded();
    expect(registry.with("jira", "issues")?.driver.listIssues).toBeDefined();
    // Not "throws when called" — absent, so a caller cannot reach a method that would lie.
    expect(registry.with("jira", "repositories")).toBeNull();
  });

  it("treats a stored id nothing registers as an orphan rather than an error", () => {
    // The restored-database case (F21 FR-7): the row is readable, and nothing can be done
    // through it.
    const registry = seeded();
    expect(registry.get("bitbucket")).toBeNull();
    expect(registry.has("bitbucket")).toBe(false);
    expect(registry.with("bitbucket", "issues")).toBeNull();
  });

  it("frees an id again when a provider is unregistered", () => {
    const registry = seeded();
    registry.unregister("jira");
    expect(registry.has("jira")).toBe(false);
    expect(registry.register(tracker("jira")).ok).toBe(true);
  });
});

describe("toManifest", () => {
  it("drops the driver, and only the driver", () => {
    // What reaches the client. A driver holds credentials-handling code and belongs on the
    // server; everything else is what the settings picker draws its form from.
    const manifest = toManifest({
      ...sourceHost("gitea"),
      name: "Gitea",
      changeRequestNoun: "pull request",
      fields: [{ key: "baseUrl", label: "Base URL", required: true, secret: false }],
    });

    expect(manifest).toEqual({
      id: "gitea",
      name: "Gitea",
      capabilities: ["issues", "repositories", "changeRequests"],
      fields: [{ key: "baseUrl", label: "Base URL", required: true, secret: false }],
      changeRequestNoun: "pull request",
    });
    expect("driver" in manifest).toBe(false);
  });

  it("omits the change-request noun rather than sending an empty one", () => {
    const manifest = toManifest(tracker("jira"));
    expect("changeRequestNoun" in manifest).toBe(false);
  });
});
