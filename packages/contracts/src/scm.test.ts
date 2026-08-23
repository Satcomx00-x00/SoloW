import { describe, expect, it } from "bun:test";
import {
  changeRequestStateSchema,
  importRepositoryInput,
  issueSourceSchema,
  listExternalIssuesInput,
  scmProviderSchema,
  syncRepositorySignalsInput,
} from "./scm.js";

describe("scmProviderSchema", () => {
  it("takes any well-formed provider id, not a fixed pair", () => {
    // The point of the registry (F21): a build that ships a third driver stores its id here, and
    // nothing in contracts had to be edited for it to be storable.
    for (const id of ["github", "gitlab", "gitea", "acme.internal-forge"]) {
      expect(scmProviderSchema.safeParse(id).success).toBe(true);
    }
  });

  it("still enforces the grammar, because the id is a stored compatibility surface", () => {
    // A column is not a free-text field. These are the shapes that would make an id unusable as
    // a key: empty, spaced, capitalised, or punctuated outside the alphabet.
    for (const bad of ["", "GitHub", "git hub", "git_hub", "-gitea", "gitea-"]) {
      expect(scmProviderSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("issueSourceSchema", () => {
  it("includes local, for Issues that belong to no provider", () => {
    expect(issueSourceSchema.safeParse("local").success).toBe(true);
  });

  it("accepts a provider id this build may not have a driver for", () => {
    // This is the restored-database case, and the reason the enum went. An Issue imported by a
    // build that shipped a Jira driver must still read back in one that does not — inert, but
    // readable (F21 FR-7). Refusing to parse it would take the whole Issues page down.
    expect(issueSourceSchema.safeParse("jira").success).toBe(true);
    expect(issueSourceSchema.safeParse("gitea").success).toBe(true);
  });

  it("rejects a source that is not a legal id", () => {
    expect(issueSourceSchema.safeParse("Not An Id").success).toBe(false);
  });
});

describe("changeRequestStateSchema", () => {
  it('is the neutral three states — never "pull_request" or "merge_request"', () => {
    expect(changeRequestStateSchema.options).toEqual(["open", "closed", "merged"]);
  });
});

describe("importRepositoryInput", () => {
  it("takes an Integration and a repository on it — no local Repository to name first", () => {
    const res = importRepositoryInput.safeParse({
      integrationId: "int_1",
      externalFullName: "acme/gate",
    });
    expect(res.success).toBe(true);
  });

  it("accepts an optional name override for a repository imported twice under one Workspace", () => {
    const res = importRepositoryInput.safeParse({
      integrationId: "int_1",
      externalFullName: "acme/gate",
      name: "gate-enterprise",
    });
    expect(res.success).toBe(true);
  });

  it("rejects an empty externalFullName", () => {
    const res = importRepositoryInput.safeParse({
      integrationId: "int_1",
      externalFullName: "",
    });
    expect(res.success).toBe(false);
  });
});

describe("listExternalIssuesInput / syncRepositorySignalsInput", () => {
  it("both take just a repositoryId", () => {
    expect(listExternalIssuesInput.safeParse({ repositoryId: "repo_1" }).success).toBe(true);
    expect(syncRepositorySignalsInput.safeParse({ repositoryId: "repo_1" }).success).toBe(true);
  });
});
