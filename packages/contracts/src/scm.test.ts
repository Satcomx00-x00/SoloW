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
  it("accepts exactly github and gitlab — the DoD's stated scope", () => {
    expect(scmProviderSchema.options).toEqual(["github", "gitlab"]);
  });
});

describe("issueSourceSchema", () => {
  it("includes local, for rows that predate this feature", () => {
    expect(issueSourceSchema.safeParse("local").success).toBe(true);
    expect(issueSourceSchema.safeParse("github").success).toBe(true);
    expect(issueSourceSchema.safeParse("gitlab").success).toBe(true);
  });

  it("rejects anything outside the closed set", () => {
    expect(issueSourceSchema.safeParse("jira").success).toBe(false);
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
