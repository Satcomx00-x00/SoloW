import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GitlabProvider } from "./gitlab.js";
import { ScmProviderError } from "./types.js";

/** Contract tests against a scripted fixture server — never a live GitLab API call. */

let server: ReturnType<typeof Bun.serve>;
let receivedAuth: string[] = [];
/** Full request paths including query, so a test can assert how the API was actually called. */
let receivedPaths: string[] = [];

const PROJECT = "acme/gate"; // URL-encoded as acme%2Fgate in the request path

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      receivedAuth.push(req.headers.get("private-token") ?? "");
      const url = new URL(req.url);
      receivedPaths.push(`${url.pathname}${url.search}`);

      if (url.pathname === "/api/v4/user") {
        return Response.json({ username: "glab" });
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent(PROJECT)}/issues`) {
        return Response.json([
          {
            iid: 3,
            title: "Backlight flickers",
            description: "at dusk",
            state: "opened",
            web_url: "u/issues/3",
          },
          { iid: 4, title: "Old issue", description: null, state: "closed", web_url: "u/issues/4" },
        ]);
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent(PROJECT)}/merge_requests`) {
        return Response.json([
          {
            iid: 7,
            title: "Open MR",
            state: "opened",
            web_url: "u/mr/7",
            source_branch: "feat",
            target_branch: "main",
            author: { username: "dev" },
          },
          {
            iid: 8,
            title: "Merged MR",
            state: "merged",
            web_url: "u/mr/8",
            source_branch: "fix",
            target_branch: "main",
            author: null,
          },
          {
            iid: 9,
            title: "Locked MR",
            state: "locked",
            web_url: "u/mr/9",
            source_branch: "wip",
            target_branch: "main",
            author: null,
          },
        ]);
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent(PROJECT)}/labels`) {
        return Response.json([
          { name: "bug", color: "#d73a4a", description: "Something isn't working" },
          { name: "no-description", color: "#00ff00", description: null },
        ]);
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent(PROJECT)}/repository/branches`) {
        return Response.json([
          {
            name: "main",
            default: true,
            commit: { id: "sha1", committed_date: "2026-01-01T00:00:00Z" },
          },
          {
            name: "feat",
            default: false,
            commit: { id: "sha2", committed_date: "2026-01-02T00:00:00Z" },
          },
        ]);
      }
      if (url.pathname === "/api/v4/projects") {
        // Echo the query back so the test can assert membership scoping was actually requested.
        return Response.json([
          {
            name: "gate",
            path_with_namespace: "acme/gate",
            description: "the gate",
            default_branch: "main",
            visibility: "private",
            web_url: "u/acme/gate",
            http_url_to_repo: "https://gitlab.com/acme/gate.git",
            _query: url.search,
          },
          {
            name: "internal-tools",
            path_with_namespace: "acme/internal-tools",
            description: null,
            default_branch: null,
            visibility: "internal",
            web_url: "u/acme/internal-tools",
            http_url_to_repo: "https://gitlab.com/acme/internal-tools.git",
          },
          {
            name: "docs",
            path_with_namespace: "acme/docs",
            description: null,
            default_branch: "main",
            visibility: "public",
            web_url: "u/acme/docs",
            http_url_to_repo: "https://gitlab.com/acme/docs.git",
          },
        ]);
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent("acme/private")}/issues`) {
        return new Response("404 Project Not Found", { status: 404 });
      }
      return new Response("unmapped", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

const credential = () => ({ token: "glpat-secret", baseUrl: `http://localhost:${server.port}` });

describe("GitlabProvider", () => {
  it("authenticates via the PRIVATE-TOKEN header, not Authorization: Bearer", async () => {
    receivedAuth = [];
    const result = await new GitlabProvider().authenticate(credential());
    expect(result).toEqual({ ok: true });
    expect(receivedAuth[0]).toBe("glpat-secret");
  });

  it('maps GitLab issue state "opened"/"closed" onto the neutral open/closed shape', async () => {
    const issues = await new GitlabProvider().listIssues(credential(), PROJECT);
    expect(issues).toEqual([
      {
        externalId: "3",
        number: 3,
        title: "Backlight flickers",
        description: "at dusk",
        state: "open",
        url: "u/issues/3",
      },
      {
        externalId: "4",
        number: 4,
        title: "Old issue",
        description: null,
        state: "closed",
        url: "u/issues/4",
      },
    ]);
  });

  it('maps a merge request onto ExternalChangeRequest — the domain never sees "merge request"', async () => {
    const mrs = await new GitlabProvider().listChangeRequests(credential(), PROJECT);
    expect(mrs[0]).toEqual({
      externalId: "7",
      number: 7,
      title: "Open MR",
      state: "open",
      url: "u/mr/7",
      headRef: "feat",
      baseRef: "main",
      authorLogin: "dev",
    });
    expect(mrs[1]?.state).toBe("merged");
  });

  it('treats GitLab\'s transient "locked" state as open, not a fourth domain state', async () => {
    const mrs = await new GitlabProvider().listChangeRequests(credential(), PROJECT);
    expect(mrs[2]).toMatchObject({ title: "Locked MR", state: "open" });
  });

  it("URL-encodes the project path so a repo containing a slash addresses one project", async () => {
    const branches = await new GitlabProvider().listBranches(credential(), PROJECT);
    expect(branches).toHaveLength(2);
  });

  it("reads default/commit fields into ExternalBranch, including the commit timestamp GitHub's endpoint omits", async () => {
    const branches = await new GitlabProvider().listBranches(credential(), PROJECT);
    expect(branches[0]).toEqual({
      name: "main",
      isDefault: true,
      headSha: "sha1",
      headCommittedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("lists projects the token is a member of, keyed on path_with_namespace", async () => {
    const repos = await new GitlabProvider().listRepositories(credential());
    expect(repos[0]).toEqual({
      fullName: "acme/gate",
      name: "gate",
      description: "the gate",
      defaultBranch: "main",
      isPrivate: true,
      url: "u/acme/gate",
      cloneUrl: "https://gitlab.com/acme/gate.git",
    });
    // fullName is the RepoRef every other method takes, so a picked value needs no reformatting.
    expect(repos.map((r) => r.fullName)).toEqual(["acme/gate", "acme/internal-tools", "acme/docs"]);
  });

  it("scopes the project list to membership — otherwise GitLab returns every public project", async () => {
    receivedPaths = [];
    await new GitlabProvider().listRepositories(credential());
    expect(receivedPaths.at(-1)).toContain("membership=true");
  });

  it("reports the clone URL the provider gives, with no credential in it", async () => {
    const repos = await new GitlabProvider().listRepositories(credential());
    // http_url_to_repo, not ssh_url_to_repo: the import path authenticates over https with the
    // Integration's token, which needs no key material on the host.
    expect(repos[0]?.cloneUrl).toBe("https://gitlab.com/acme/gate.git");
    expect(repos.every((r) => !r.cloneUrl.includes("@"))).toBe(true);
  });

  it('treats GitLab "internal" visibility as private, not as publicly readable', async () => {
    const repos = await new GitlabProvider().listRepositories(credential());
    const internal = repos.find((r) => r.fullName === "acme/internal-tools");
    const open = repos.find((r) => r.fullName === "acme/docs");
    expect(internal?.isPrivate).toBe(true);
    expect(open?.isPrivate).toBe(false);
  });

  it("passes GitLab's already-#-prefixed label color through unchanged", async () => {
    const labels = await new GitlabProvider().listLabels(credential(), PROJECT);
    expect(labels).toEqual([
      { name: "bug", color: "#d73a4a", description: "Something isn't working" },
      { name: "no-description", color: "#00ff00", description: null },
    ]);
  });

  it("throws ScmProviderError on a non-2xx response, token never in the message", async () => {
    try {
      await new GitlabProvider().listIssues(credential(), "acme/private");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ScmProviderError);
      expect(String(e)).not.toContain("glpat-secret");
    }
  });
});
