import { afterEach, describe, expect, it } from "bun:test";
import {
  cloneUsernameFor,
  isProviderInstalled,
  listProviderManifests,
  providerFor,
  providerManifest,
  providerWith,
  testing,
} from "./index.js";

/**
 * What the registry promises at the boundary callers actually use (F21, Decision 0016).
 *
 * `packages/core` tests the registry as pure logic. These are about the three shipped providers
 * and the two claims the decision rests on: that a provider which is not a source host can exist
 * at all, and that adding one costs nothing outside its own file.
 */

/** A tracker: issues and labels, no repositories, no change requests. The Jira shape. */
const TRACKER = {
  id: "fixture.tracker",
  name: "Fixture Tracker",
  capabilities: ["issues"] as const,
  fields: [],
  driver: {
    provider: "fixture.tracker",
    authenticate: async () => ({ ok: true as const }),
    listIssues: async () => [],
    listLabels: async () => [],
  },
};

afterEach(() => testing.unregister(TRACKER.id));

describe("the providers this build ships", () => {
  it("has all three, each a full source host", () => {
    // Gitea is the design test, exactly as GitLab was for the interface (issue #78): if adding it
    // had required a change outside `gitea.ts` and one registration, the registry would not have
    // removed what it claims to.
    expect(listProviderManifests().map((m) => m.id)).toEqual(["gitea", "github", "gitlab"]);
    for (const manifest of listProviderManifests()) {
      expect(manifest.capabilities).toEqual(["issues", "repositories", "changeRequests"]);
    }
  });

  it("keeps each provider's own noun out of the domain and in its manifest", () => {
    expect(providerManifest("github")?.changeRequestNoun).toBe("pull request");
    expect(providerManifest("gitlab")?.changeRequestNoun).toBe("merge request");
  });

  it("requires a base URL for Gitea and not for the two with a hosted instance", () => {
    const required = (id: string) =>
      providerManifest(id)?.fields.find((f) => f.key === "baseUrl")?.required;
    // Gitea has no gitea.com to fall back to, so a connection with no host is not a connection.
    expect(required("gitea")).toBe(true);
    expect(required("github")).toBe(false);
    expect(required("gitlab")).toBe(false);
  });

  it("carries the https clone username beside the registration", () => {
    expect(cloneUsernameFor("github")).toBe("x-access-token");
    expect(cloneUsernameFor("gitlab")).toBe("oauth2");
    expect(cloneUsernameFor("gitea")).toBe("oauth2");
    // A provider nothing registers still clones: every host here authenticates on the token and
    // ignores the username, so the conventional one is a better answer than a crash.
    expect(cloneUsernameFor("bitbucket")).toBe("git");
  });
});

describe("a provider that is not a source host", () => {
  it("can be registered, which a single flat interface would not have allowed", () => {
    // The claim Decision 0016 rests on. Under the old `ChangeProvider` this driver could not
    // exist without four methods that throw.
    expect(testing.register(TRACKER).ok).toBe(true);
    expect(isProviderInstalled("fixture.tracker")).toBe(true);
  });

  it("is offered for issues and withheld from repositories", () => {
    testing.register(TRACKER);
    expect(listProviderManifests("issues").map((m) => m.id)).toContain("fixture.tracker");
    // A Repository picker that offered it would be offering something with no repositories.
    expect(listProviderManifests("repositories").map((m) => m.id)).not.toContain("fixture.tracker");
  });

  it("hands out a driver only for what it declared", () => {
    testing.register(TRACKER);
    expect(providerWith("fixture.tracker", "issues")).not.toBeNull();
    // Null, not a driver whose `listBranches` would throw: a caller cannot reach a method the
    // provider never claimed.
    expect(providerWith("fixture.tracker", "repositories")).toBeNull();
    expect(providerWith("fixture.tracker", "changeRequests")).toBeNull();
  });
});

describe("a provider nothing registers", () => {
  it("resolves to nothing rather than throwing", () => {
    // The restored-database case. Every one of these is an ordinary answer, which is what lets a
    // row carrying the id stay readable (F21 FR-7).
    expect(providerFor("bitbucket")).toBeNull();
    expect(providerWith("bitbucket", "issues")).toBeNull();
    expect(providerManifest("bitbucket")).toBeNull();
    expect(isProviderInstalled("bitbucket")).toBe(false);
  });
});
