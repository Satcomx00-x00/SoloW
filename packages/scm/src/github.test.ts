import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GithubProvider } from "./github.js";
import { ScmProviderError } from "./types.js";

/**
 * Contract tests against a scripted fixture server, never a live GitHub API call (Principle
 * VI / issue #15 DoD) — `Bun.serve` stands in for `api.github.com`, and the driver's `baseUrl`
 * points at it via the same GHE-style override path a self-hoster would use.
 */

let server: ReturnType<typeof Bun.serve>;
let receivedAuth: string[] = [];
/** Full request paths including query, so a test can assert how the API was actually called. */
let receivedPaths: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      receivedAuth.push(req.headers.get("authorization") ?? "");
      const url = new URL(req.url);
      receivedPaths.push(`${url.pathname}${url.search}`);

      if (url.pathname === "/api/v3/user") {
        return Response.json({ login: "octocat" });
      }
      if (url.pathname === "/api/v3/user/repos") {
        return Response.json([
          {
            name: "gate",
            full_name: "acme/gate",
            description: "the gate",
            default_branch: "main",
            private: true,
            html_url: "u/acme/gate",
          },
          {
            name: "docs",
            full_name: "acme/docs",
            description: null,
            default_branch: null,
            private: false,
            html_url: "u/acme/docs",
          },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/gate/issues") {
        return Response.json([
          {
            id: 1,
            number: 10,
            title: "Real issue",
            body: "from GitHub",
            state: "open",
            html_url: "https://github.com/acme/gate/issues/10",
          },
          // GitHub's issues endpoint also returns pull requests — must be filtered out.
          {
            id: 2,
            number: 11,
            title: "A PR, not an issue",
            body: null,
            state: "open",
            html_url: "https://github.com/acme/gate/pull/11",
            pull_request: {},
          },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/gate/pulls") {
        return Response.json([
          {
            id: 20,
            number: 5,
            title: "Open PR",
            state: "open",
            merged_at: null,
            html_url: "u1",
            head: { ref: "feat" },
            base: { ref: "main" },
            user: { login: "dev" },
          },
          {
            id: 21,
            number: 6,
            title: "Merged PR",
            state: "closed",
            merged_at: "2026-01-01T00:00:00Z",
            html_url: "u2",
            head: { ref: "fix" },
            base: { ref: "main" },
            user: null,
          },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/gate") {
        return Response.json({ default_branch: "main" });
      }
      if (url.pathname === "/api/v3/repos/acme/gate/branches") {
        return Response.json([
          { name: "main", commit: { sha: "abc123" } },
          { name: "feat", commit: { sha: "def456" } },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/private/issues") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("unmapped", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

const credential = () => ({ token: "gh-pat-secret", baseUrl: `http://localhost:${server.port}` });

describe("GithubProvider", () => {
  it("authenticates by hitting /user with a Bearer token", async () => {
    receivedAuth = [];
    const result = await new GithubProvider().authenticate(credential());
    expect(result).toEqual({ ok: true });
    expect(receivedAuth[0]).toBe("Bearer gh-pat-secret");
  });

  it("lists issues, excluding rows that are actually pull requests", async () => {
    const issues = await new GithubProvider().listIssues(credential(), "acme/gate");
    expect(issues).toEqual([
      {
        externalId: "1",
        number: 10,
        title: "Real issue",
        description: "from GitHub",
        state: "open",
        url: "https://github.com/acme/gate/issues/10",
      },
    ]);
  });

  it('maps merged_at to state "merged", overriding the raw "closed" state', async () => {
    const prs = await new GithubProvider().listChangeRequests(credential(), "acme/gate");
    expect(prs).toEqual([
      {
        externalId: "20",
        number: 5,
        title: "Open PR",
        state: "open",
        url: "u1",
        headRef: "feat",
        baseRef: "main",
        authorLogin: "dev",
      },
      {
        externalId: "21",
        number: 6,
        title: "Merged PR",
        state: "merged",
        url: "u2",
        headRef: "fix",
        baseRef: "main",
        authorLogin: null,
      },
    ]);
  });

  it("marks the branch matching the repo's default_branch as isDefault", async () => {
    const branches = await new GithubProvider().listBranches(credential(), "acme/gate");
    expect(branches).toEqual([
      { name: "main", isDefault: true, headSha: "abc123", headCommittedAt: null },
      { name: "feat", isDefault: false, headSha: "def456", headCommittedAt: null },
    ]);
  });

  it("lists the repositories the token can see, keyed on full_name", async () => {
    const repos = await new GithubProvider().listRepositories(credential());
    expect(repos[0]).toEqual({
      fullName: "acme/gate",
      name: "gate",
      description: "the gate",
      defaultBranch: "main",
      isPrivate: true,
      url: "u/acme/gate",
    });
    // fullName is the RepoRef every other method takes, so a picked value needs no reformatting.
    expect(repos.map((r) => r.fullName)).toEqual(["acme/gate", "acme/docs"]);
  });

  it("asks the authenticated-user endpoint — the only one returning private and org repos", async () => {
    receivedPaths = [];
    await new GithubProvider().listRepositories(credential());
    const path = receivedPaths.at(-1) ?? "";
    expect(path.startsWith("/api/v3/user/repos")).toBe(true);
    expect(decodeURIComponent(path)).toContain(
      "affiliation=owner,collaborator,organization_member",
    );
  });

  it("reports visibility so the picker can mark a private repository", async () => {
    const repos = await new GithubProvider().listRepositories(credential());
    expect(repos.find((r) => r.fullName === "acme/gate")?.isPrivate).toBe(true);
    expect(repos.find((r) => r.fullName === "acme/docs")?.isPrivate).toBe(false);
  });

  it("throws ScmProviderError, never a bare fetch error, on a non-2xx response", async () => {
    await expect(
      new GithubProvider().listIssues(credential(), "acme/private"),
    ).rejects.toBeInstanceOf(ScmProviderError);
  });

  it("never puts the token in a thrown error's message", async () => {
    try {
      await new GithubProvider().listIssues(credential(), "acme/private");
      throw new Error("expected a throw");
    } catch (e) {
      expect(String(e)).not.toContain("gh-pat-secret");
    }
  });

  it("targets the GHE-style /api/v3 path when baseUrl is set, not api.github.com", async () => {
    // Every fixture route above is served under /api/v3 — a passing suite already proves this,
    // but assert it explicitly so a future refactor that hardcodes api.github.com fails loudly.
    const branches = await new GithubProvider().listBranches(credential(), "acme/gate");
    expect(branches.length).toBeGreaterThan(0);
  });
});
