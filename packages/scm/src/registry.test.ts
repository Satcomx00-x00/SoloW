import { afterEach, describe, expect, it } from "bun:test";
import {
  ISSUE_FIELDS,
  issueCreateSupportSchema,
  issueWriteSupportSchema,
  PROJECT_FIELD_TYPES,
  projectFieldSupportSchema,
} from "@solow/contracts";
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
    getIssue: async () => ({}) as never,
    listComments: async () => [],
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
      for (const capability of ["issues", "repositories", "changeRequests"] as const) {
        expect(manifest.capabilities).toContain(capability);
      }
    }
  });

  it("does not require every provider to have every capability", () => {
    // The property the registry exists for, and the one an equality assertion here would have
    // quietly forbidden: GitHub and GitLab carry projects (F23), Gitea does not. A build where
    // all three matched would prove nothing about the abstraction.
    expect(providerManifest("github")?.capabilities).toContain("projects");
    expect(providerManifest("gitlab")?.capabilities).toContain("projects");
    expect(providerManifest("gitea")?.capabilities).not.toContain("projects");
  });

  describe("what a project can hold, per provider (Decision 0018)", () => {
    it("GitHub expresses every field type, because Projects v2 does", () => {
      const support = providerManifest("github")?.projectFields;
      expect(support?.cannot).toEqual({});
      for (const type of PROJECT_FIELD_TYPES) expect(support?.expresses).toContain(type);
    });

    it("GitLab refuses the types a scoped label cannot carry, with a reason a person can read", () => {
      // The declaration that keeps GitLab first-class rather than a degraded GitHub. A scoped
      // label is a single-select; faking a number inside a label name is how a planning tool
      // starts lying about arithmetic.
      const support = providerManifest("gitlab")?.projectFields;
      expect(support?.expresses).toContain("single_select");
      expect(support?.expresses).not.toContain("number");
      expect(support?.cannot.number).toMatch(/paid tier/i);
      expect(support?.cannot.date).toBeTruthy();
      expect(support?.cannot.iteration).toBeTruthy();
    });

    it("every field type is either expressible or refused — never unanswered", () => {
      // A type in neither is a provider that has not answered, and a table cannot render a
      // column it has no answer for. Enforced by the schema; asserted here for both drivers.
      for (const id of ["github", "gitlab"]) {
        const support = providerManifest(id)?.projectFields;
        for (const type of PROJECT_FIELD_TYPES) {
          const answered = support?.expresses.includes(type) || type in (support?.cannot ?? {});
          expect(answered).toBe(true);
        }
      }
    });

    it("a provider without the capability declares nothing about fields", () => {
      expect(providerManifest("gitea")?.projectFields).toBeUndefined();
    });
  });

  describe("who can create an Issue or Epic on the provider (spec F23a)", () => {
    it("GitHub and GitLab both declare issueCreates; Gitea declares neither", () => {
      expect(providerManifest("github")?.capabilities).toContain("issueCreates");
      expect(providerManifest("gitlab")?.capabilities).toContain("issueCreates");
      expect(providerManifest("gitea")?.capabilities).not.toContain("issueCreates");
    });

    it("GitLab can create an epic; GitHub cannot, and says so rather than leaving it unanswered", () => {
      // The "New epic" menu entry reads this to show itself disabled with the reason instead of
      // hiding (Decision 0016: a capability difference is stated, never hidden).
      expect(providerManifest("gitlab")?.issueCreates?.epics).toBe(true);
      expect(providerManifest("github")?.issueCreates?.epics).toBe(false);
    });

    it("GitLab declares the four extra issue fields; GitHub declares none of them", () => {
      // What the compose form gates each control on (user request 2026-08-30) — asked of the
      // manifest, never of the provider's name.
      const gitlab = providerManifest("gitlab")?.issueCreates;
      const github = providerManifest("github")?.issueCreates;
      for (const flag of ["dueDate", "weight", "confidential", "timeEstimate"] as const) {
        expect(gitlab?.[flag]).toBe(true);
        // Explicitly false, not merely absent: "we checked and it has none" and "nobody has said"
        // must not look the same in a manifest.
        expect(github?.[flag]).toBe(false);
      }
    });

    it("GitHub declares the three fields of its own, and GitLab declares none of them", () => {
      // The other direction of the same rule (user request 2026-08-31). The point worth holding:
      // there is no "standard" set with a GitLab annexe — each provider declares what it holds.
      const gitlab = providerManifest("gitlab")?.issueCreates;
      const github = providerManifest("github")?.issueCreates;
      for (const flag of ["issueTypes", "parentIssue", "providerProject"] as const) {
        expect(github?.[flag]).toBe(true);
        expect(gitlab?.[flag]).toBe(false);
      }
    });

    it("both declare links, and GitHub narrows them to the two relations it expresses", () => {
      // GitHub's issue dependencies are blocking in both directions and nothing else. Narrowing
      // the set is what keeps the form from offering a "relates to" the driver would then drop.
      expect(providerManifest("gitlab")?.issueCreates?.links).toBe(true);
      expect(providerManifest("github")?.issueCreates?.links).toBe(true);
      expect(providerManifest("gitlab")?.issueCreates?.linkTypes).toEqual([
        "relates_to",
        "blocks",
        "is_blocked_by",
      ]);
      expect(providerManifest("github")?.issueCreates?.linkTypes).toEqual([
        "blocks",
        "is_blocked_by",
      ]);
    });

    it("a provider without the capability declares nothing about issue creation", () => {
      expect(providerManifest("gitea")?.issueCreates).toBeUndefined();
    });
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

/**
 * The manifests every shipped provider declares, checked against the schemas that describe them.
 *
 * This exists because the registry validates a provider's **id** and nothing else (see
 * `registerProvider`): `issueWriteSupportSchema`'s "every field is writable or explained"
 * refinement is not run at registration, and TypeScript cannot catch a missing entry either —
 * `writes` is an array and `cannot` a partial record, so a manifest that simply forgets a field
 * type-checks and registers happily.
 *
 * Which made the refinement decorative. It is the guarantee the issue drawer leans on — a field
 * in neither list renders no control *and* no reason, the silent gap F23 FR-5 exists to prevent —
 * so it is asserted here, where CI runs it, rather than trusted.
 */
describe("every shipped manifest satisfies the schema that describes it", () => {
  for (const id of ["github", "gitlab", "gitea"]) {
    it(`${id} declares a complete, non-contradictory issueWrites`, () => {
      const manifest = providerManifest(id);
      expect(manifest).not.toBeNull();
      const declared = manifest?.issueWrites;
      expect(declared).toBeDefined();
      // Throws on either refinement: a field in both lists, or a field in neither.
      expect(() => issueWriteSupportSchema.parse(declared)).not.toThrow();
      // Said twice on purpose — the parse above would pass a manifest that named a field this
      // build does not have, and the drawer iterates the build's list, not the manifest's.
      for (const field of ISSUE_FIELDS) {
        const answered =
          (declared?.writes.includes(field) ?? false) || field in (declared?.cannot ?? {});
        expect(answered).toBe(true);
      }
    });
  }

  it("would actually catch an incomplete manifest — the negative control", () => {
    // Without this, the three assertions above could be vacuous: if the schema accepted anything,
    // "does not throw" would prove nothing. A manifest missing one field must be rejected...
    expect(() =>
      issueWriteSupportSchema.parse({ writes: ["title"], cannot: { description: "no" } }),
    ).toThrow();
    // ...and so must one that claims a field is both writable and refused.
    expect(() =>
      issueWriteSupportSchema.parse({
        writes: [...ISSUE_FIELDS],
        cannot: { title: "contradiction" },
      }),
    ).toThrow();
  });

  it("gitlab and github declare a valid issueCreates; gitea declares none at all", () => {
    expect(() =>
      issueCreateSupportSchema.parse(providerManifest("gitlab")?.issueCreates),
    ).not.toThrow();
    expect(() =>
      issueCreateSupportSchema.parse(providerManifest("github")?.issueCreates),
    ).not.toThrow();
    expect(providerManifest("gitea")?.issueCreates).toBeUndefined();
  });

  it("gitlab and github declare a complete projectFields; both refinements hold", () => {
    for (const id of ["github", "gitlab"]) {
      expect(() =>
        projectFieldSupportSchema.parse(providerManifest(id)?.projectFields),
      ).not.toThrow();
    }
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
