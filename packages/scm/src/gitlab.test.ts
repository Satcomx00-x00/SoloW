import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GitlabProvider } from "./gitlab.js";
import { ScmProviderError } from "./types.js";

/** Contract tests against a scripted fixture server — never a live GitLab API call. */

let server: ReturnType<typeof Bun.serve>;
let receivedAuth: string[] = [];

const PROJECT = "acme/gate"; // URL-encoded as acme%2Fgate in the request path

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      receivedAuth.push(req.headers.get("private-token") ?? "");
      const url = new URL(req.url);

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
