import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GitlabProvider } from "./gitlab.js";
import { ScmProviderError } from "./types.js";

/** Contract tests against a scripted fixture server — never a live GitLab API call. */

let server: ReturnType<typeof Bun.serve>;
let receivedAuth: string[] = [];
/** Full request paths including query, so a test can assert how the API was actually called. */
let receivedPaths: string[] = [];
/** `METHOD path` and body of every request that is not a GET — the verb is asserted, not assumed. */
let receivedWrites: Array<{ method: string; path: string; body: unknown }> = [];

const PROJECT = "acme/gate"; // URL-encoded as acme%2Fgate in the request path
const LINKED = "acme/linked";
/** A project on a tier that has epics — where GitLab reports a hierarchy at all (issue #127). */
const PREMIUM = "acme/premium";
/** A project whose related-MR calls are throttled — the enrichment failure that matters. */
const BUSY = "acme/busy";
/** A group on a tier that has epics — the create/list-epic fixtures (spec F23a). */
const GROUP = "acme/platform";
const project = (path: string) => `/api/v4/projects/${encodeURIComponent(path)}`;
const group = (path: string) => `/api/v4/groups/${encodeURIComponent(path)}`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      receivedAuth.push(req.headers.get("private-token") ?? "");
      const url = new URL(req.url);
      receivedPaths.push(`${url.pathname}${url.search}`);
      if (req.method !== "GET") {
        receivedWrites.push({
          method: req.method,
          path: url.pathname,
          body: await req
            .clone()
            .json()
            .catch(() => undefined),
        });
      }

      if (url.pathname === "/api/v4/user") {
        return Response.json({ username: "glab" });
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent(PROJECT)}/issues`) {
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({
            iid: 20,
            title: body.title,
            description: body.description ?? null,
            state: "opened",
            web_url: "u/issues/20",
            labels: body.labels === undefined ? [] : String(body.labels).split(",").filter(Boolean),
            assignees: ((body.assignee_ids as number[]) ?? []).map((id) => ({
              username: id === 7 ? "ada" : `user-${id}`,
            })),
            milestone: body.milestone_id
              ? { id: body.milestone_id, title: "v1", start_date: null, due_date: null }
              : null,
          });
        }
        return Response.json([
          {
            iid: 3,
            title: "Backlight flickers",
            description: "at dusk",
            state: "opened",
            web_url: "u/issues/3",
            labels: ["bug", "status::doing"],
            assignees: [{ username: "glab", name: "GLab", avatar_url: "a/glab.png" }],
            milestone: { id: 90, title: "v1", start_date: "2026-08-01", due_date: "2026-09-01" },
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
      if (url.pathname === "/api/v4/groups") {
        // Echo the query back so a test can assert the access-level floor was actually requested.
        return Response.json([
          {
            id: 55,
            full_path: "acme/platform",
            name: "Platform",
            web_url: "u/acme/platform",
            _query: url.search,
          },
          { id: 56, full_path: "acme/design", name: "Design", web_url: "u/acme/design" },
        ]);
      }
      if (url.pathname === `${group(GROUP)}/epics`) {
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({
            id: 900,
            iid: 12,
            group_id: 55,
            title: body.title,
            state: "opened",
            web_url: "u/epics/12",
            // GitLab computes these from milestones unless the _fixed flags were set — the
            // fixture stands in for that by echoing the fixed value only when it was sent.
            start_date: body.start_date_is_fixed ? (body.start_date_fixed ?? null) : null,
            due_date: body.due_date_is_fixed ? (body.due_date_fixed ?? null) : null,
          });
        }
        return Response.json([
          {
            id: 901,
            iid: 13,
            group_id: 55,
            title: "Existing epic",
            state: "opened",
            web_url: "u/epics/13",
            start_date: "2026-08-01",
            due_date: "2026-09-01",
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
      /**
       * A project whose issues carry related merge requests (issue #128). Kept apart from
       * `acme/gate` so the existing listing fixture keeps covering the case where the related-MR
       * call cannot be answered at all.
       */
      if (url.pathname === `/api/v4/projects/${encodeURIComponent(LINKED)}/issues`) {
        return Response.json([
          {
            iid: 10,
            title: "Several in flight",
            description: null,
            state: "opened",
            web_url: "u/issues/10",
          },
          {
            iid: 11,
            title: "Nothing in flight",
            description: null,
            state: "opened",
            web_url: "u/issues/11",
          },
        ]);
      }
      if (
        url.pathname ===
        `/api/v4/projects/${encodeURIComponent(LINKED)}/issues/10/related_merge_requests`
      ) {
        return Response.json([
          {
            id: 500,
            iid: 7,
            title: "Open MR",
            state: "opened",
            web_url: "u/mr/7",
            merged_at: null,
          },
          {
            id: 501,
            iid: 8,
            title: "Merged MR",
            state: "merged",
            web_url: "u/mr/8",
            merged_at: "2026-01-02T00:00:00Z",
          },
        ]);
      }
      if (
        url.pathname ===
        `/api/v4/projects/${encodeURIComponent(LINKED)}/issues/11/related_merge_requests`
      ) {
        return Response.json([]);
      }
      /**
       * The tier that has epics. `epic` present and null is "no epic"; the key being *absent*,
       * as it is on every other fixture project here, is GitLab Free having no such feature.
       */
      if (url.pathname === `${project(PREMIUM)}/issues`) {
        return Response.json([
          {
            iid: 3,
            title: "Under an epic",
            description: null,
            state: "opened",
            web_url: "u/issues/3",
            epic: { id: 77 },
          },
          {
            iid: 4,
            title: "Under no epic",
            description: null,
            state: "opened",
            web_url: "u/issues/4",
            epic: null,
          },
        ]);
      }
      if (url.pathname === `${project(BUSY)}/issues`) {
        return Response.json(
          Array.from({ length: 8 }, (_unused, i) => ({
            iid: i + 1,
            title: `Issue ${i + 1}`,
            description: null,
            state: "opened",
            web_url: `u/issues/${i + 1}`,
          })),
        );
      }
      if (url.pathname.startsWith(`${project(BUSY)}/issues/`)) {
        return new Response("429 Too Many Requests", { status: 429 });
      }
      if (url.pathname === `/api/v4/projects/${encodeURIComponent("acme/private")}/issues`) {
        return new Response("404 Project Not Found", { status: 404 });
      }
      if (url.pathname === `${project(PROJECT)}/issues/3`) {
        if (req.method === "PUT") {
          const patch = (await req.json()) as Record<string, unknown>;
          return Response.json({
            iid: 3,
            title: patch.title ?? "Backlight flickers",
            description: patch.description ?? "at dusk",
            state: patch.state_event === "close" ? "closed" : "opened",
            web_url: "u/issues/3",
            labels:
              patch.labels === undefined
                ? ["bug"]
                : String(patch.labels).split(",").filter(Boolean),
            assignees: ((patch.assignee_ids as number[]) ?? []).map((id) => ({
              username: id === 7 ? "ada" : `user-${id}`,
            })),
            milestone: patch.milestone_id ? { id: patch.milestone_id, title: "v1" } : null,
          });
        }
        return Response.json({
          iid: 3,
          title: "Backlight flickers",
          description: "at dusk",
          state: "opened",
          web_url: "u/issues/3",
          labels: ["bug"],
          assignees: [{ username: "ada", name: "Ada", avatar_url: "a.png" }],
          milestone: { id: 90, title: "v1", start_date: null, due_date: "2026-09-01" },
        });
      }
      if (url.pathname === `${project(PROJECT)}/issues/3/notes`) {
        if (req.method === "POST") {
          const body = (await req.json()) as { body: string };
          return Response.json({
            id: 9,
            body: body.body,
            created_at: "2026-08-26T10:00:00Z",
            author: { username: "ada", name: "Ada" },
          });
        }
        return Response.json([
          {
            id: 1,
            body: "A person wrote this",
            created_at: "2026-08-20T00:00:00Z",
            author: { username: "ada", name: "Ada" },
          },
          {
            id: 2,
            body: "changed title from **A** to **B**",
            created_at: "2026-08-20T00:01:00Z",
            system: true,
            author: { username: "ada" },
          },
        ]);
      }
      if (url.pathname === `${project(PROJECT)}/users`) {
        return Response.json([
          { id: 7, username: "ada", name: "Ada", avatar_url: "a.png" },
          { id: 8, username: "grace", name: null, avatar_url: null },
        ]);
      }
      if (url.pathname === `${project(PROJECT)}/milestones`) {
        return Response.json([
          { id: 90, title: "v1", start_date: "2026-08-01", due_date: "2026-09-01" },
        ]);
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
        labels: ["bug", "status::doing"],
        assignees: [{ login: "glab", name: "GLab", avatarUrl: "a/glab.png" }],
        milestone: {
          externalId: "90",
          title: "v1",
          startDate: "2026-08-01",
          dueDate: "2026-09-01",
        },
      },
      {
        externalId: "4",
        number: 4,
        title: "Old issue",
        description: null,
        state: "closed",
        url: "u/issues/4",
        labels: [],
        assignees: [],
        milestone: null,
      },
    ]);
  });

  it("mirrors the merge requests GitLab relates to an issue", async () => {
    // #128 AC-1. `related_merge_requests` is GitLab's own answer, so nothing here parses a
    // description for "Closes #10".
    const issues = await new GitlabProvider().listIssues(credential(), LINKED, {
      linkedChangeRequests: true,
    });
    expect(issues[0]?.linkedChangeRequests).toEqual([
      {
        // The MR's global id, not its per-project iid — which restarts at 1 in every project.
        externalId: "500",
        number: 7,
        title: "Open MR",
        state: "open",
        url: "u/mr/7",
        mergedAt: null,
      },
      {
        externalId: "501",
        number: 8,
        title: "Merged MR",
        state: "merged",
        url: "u/mr/8",
        mergedAt: "2026-01-02T00:00:00Z",
      },
    ]);
  });

  it("reports an issue with no related merge request as an empty list, not as absent", async () => {
    // "Nothing is in flight" is an answer, and the table renders it as one.
    const issues = await new GitlabProvider().listIssues(credential(), LINKED, {
      linkedChangeRequests: true,
    });
    expect(issues[1]?.linkedChangeRequests).toEqual([]);
  });

  it("omits the links entirely when the related-MR call fails", async () => {
    // `acme/gate` has no related-MR fixture, so the side call 404s. Omitting is what lets the sync
    // keep the links it last confirmed rather than blanking the column over one failed request.
    const issues = await new GitlabProvider().listIssues(credential(), PROJECT, {
      linkedChangeRequests: true,
    });
    expect(issues[0] && "linkedChangeRequests" in issues[0]).toBe(false);
  });

  describe("the per-issue enrichment is something a caller asks for (issue #128)", () => {
    it("calls the related-MR endpoint only when the links were asked for", async () => {
      // The cost this removes: the connect-time auto-import walks every project the token can
      // see, and used to spend a request per issue filling a column it discarded.
      receivedPaths = [];
      const issues = await new GitlabProvider().listIssues(credential(), LINKED);

      expect(issues).toHaveLength(2);
      expect(receivedPaths.filter((p) => p.includes("related_merge_requests"))).toEqual([]);
      expect(issues.every((i) => !("linkedChangeRequests" in i))).toBe(true);
    });

    it("fails the listing when the provider throttles the enrichment", async () => {
      // A 429 swallowed per issue is a rate limit rendered as "nothing is in flight" — the one
      // failure indistinguishable from the truth. It has to reach the caller, and it has to
      // still say 429, because that is what the sync's backoff matches on.
      const failing = new GitlabProvider().listIssues(credential(), BUSY, {
        linkedChangeRequests: true,
      });

      await expect(failing).rejects.toBeInstanceOf(ScmProviderError);
      await expect(failing).rejects.toThrow(/429/);
    });

    it("never answers a throttled enrichment with an empty link list", async () => {
      const issues = await new GitlabProvider()
        .listIssues(credential(), BUSY, { linkedChangeRequests: true })
        .catch(() => []);

      expect(issues.some((i) => i.linkedChangeRequests !== undefined)).toBe(false);
    });

    it("stops fanning out once the provider has said slow down", async () => {
      // Eight issues, a window of five: the rest must not spend a request on a token that has
      // already been throttled.
      receivedPaths = [];
      await new GitlabProvider()
        .listIssues(credential(), BUSY, { linkedChangeRequests: true })
        .catch(() => undefined);

      const related = receivedPaths.filter((p) => p.includes("related_merge_requests"));
      expect(related.length).toBeGreaterThan(0);
      expect(related.length).toBeLessThan(8);
    });
  });

  describe("the issue hierarchy (spec F23 FR-7, issue #127)", () => {
    it("reports the epic an issue belongs to, in a space no issue id can collide with", async () => {
      // The collision this prevents: an issue's `externalId` is its per-project `iid` and an
      // epic's id is an instance-wide counter, so an unprefixed `77` would be matched against
      // issue #77 of the same project and nest the row under a stranger.
      const issues = await new GitlabProvider().listIssues(credential(), PREMIUM);

      expect(issues.map((i) => i.parentExternalId)).toEqual(["epic-77", null]);
    });

    it("omits the parent entirely on a tier that has no epics", async () => {
      // GitLab Free returns no `epic` key at all. Reporting `null` would be SoloW saying
      // the issue has no parent on a plan where it could not have one — and the mirror would
      // erase, on every poll, an edge that a Premium instance had established.
      const issues = await new GitlabProvider().listIssues(credential(), PROJECT);

      expect(issues.every((i) => !("parentExternalId" in i))).toBe(true);
    });
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

  it("createLabels skips what's already there and POSTs only what's missing", async () => {
    receivedWrites = [];
    const result = await new GitlabProvider().createLabels(credential(), PROJECT, [
      { name: "bug", color: "#ff0000", description: "would collide" },
      { name: "type/feat", color: "#0e8a16", description: "A new feature" },
    ]);

    expect(result.existing).toEqual(["bug"]);
    expect(result.created).toEqual(["type/feat"]);
    // One write, POST — not the GET `provisionProjectStructure` originally shipped as a bug.
    expect(receivedWrites).toHaveLength(1);
    expect(receivedWrites[0]?.method).toBe("POST");
    expect(receivedWrites[0]?.body).toEqual({
      name: "type/feat",
      color: "#0e8a16",
      description: "A new feature",
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

describe("writing an issue back to GitLab", () => {
  const gitlab = () => new GitlabProvider();

  it("sends a PUT, not a GET — GitLab answers a GET with the unchanged issue", async () => {
    receivedWrites = [];

    await gitlab().updateIssue(credential(), PROJECT, 3, { title: "Renamed" });

    expect(receivedWrites).toHaveLength(1);
    expect(receivedWrites[0]?.method).toBe("PUT");
  });

  it("closes with a state *event*, because GitLab accepts and ignores a state", async () => {
    // `state: "closed"` is taken by GitLab without complaint and changes nothing — a write that
    // reports success and does not happen.
    receivedWrites = [];

    const stored = await gitlab().updateIssue(credential(), PROJECT, 3, { state: "closed" });

    expect(receivedWrites[0]?.body).toEqual({ state_event: "close" });
    expect(stored.state).toBe("closed");
  });

  it("resolves logins to the numeric ids GitLab assigns by", async () => {
    // GitLab will not assign by username. An editor works in logins, so the driver is where the
    // two meet — anywhere else and every caller would have to know this about one provider.
    receivedWrites = [];

    const stored = await gitlab().updateIssue(credential(), PROJECT, 3, { assignees: ["ada"] });

    expect(receivedWrites[0]?.body).toEqual({ assignee_ids: [7] });
    expect(stored.assignees?.map((u) => u.login)).toEqual(["ada"]);
  });

  it("drops a login the project does not know instead of failing the whole patch", async () => {
    receivedWrites = [];

    await gitlab().updateIssue(credential(), PROJECT, 3, { assignees: ["ada", "nobody"] });

    expect(receivedWrites[0]?.body).toEqual({ assignee_ids: [7] });
  });

  it("clears a milestone with 0, which is what GitLab takes — a null is ignored", async () => {
    receivedWrites = [];

    await gitlab().updateIssue(credential(), PROJECT, 3, { milestone: null });

    expect(receivedWrites[0]?.body).toEqual({ milestone_id: 0 });
  });

  it("joins labels into the comma-separated string GitLab expects", async () => {
    receivedWrites = [];

    const stored = await gitlab().updateIssue(credential(), PROJECT, 3, {
      labels: ["bug", "urgent"],
    });

    expect(receivedWrites[0]?.body).toEqual({ labels: "bug,urgent" });
    expect(stored.labels).toEqual(["bug", "urgent"]);
  });

  it("reads one issue with the assignees, labels and milestone a listing drops", async () => {
    const issue = await gitlab().getIssue(credential(), PROJECT, 3);

    expect(issue.assignees?.map((u) => u.login)).toEqual(["ada"]);
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.milestone?.dueDate).toBe("2026-09-01");
  });
});

describe("issue comments on GitLab", () => {
  const gitlab = () => new GitlabProvider();

  it("drops the system notes, which are bookkeeping and not a conversation", async () => {
    /*
     * The whole reason this driver is not a one-liner. GitLab returns *notes*, and most of them
     * are the system recording a label change; GitHub keeps that in a separate timeline. Passing
     * them through would make one provider's issue read as a wall of bookkeeping and the other's
     * as a discussion — the same screen meaning two different things depending on the host.
     */
    const comments = await gitlab().listComments(credential(), PROJECT, 3);

    expect(comments.map((c) => c.body)).toEqual(["A person wrote this"]);
  });

  it("posts a note and reads back what GitLab stored", async () => {
    receivedWrites = [];

    const posted = await gitlab().createComment(credential(), PROJECT, 3, "Agreed");

    expect(receivedWrites[0]?.method).toBe("POST");
    expect(posted.body).toBe("Agreed");
    expect(posted.author?.login).toBe("ada");
  });
});

describe("creating an Issue or Epic on GitLab (spec F23a)", () => {
  const gitlab = () => new GitlabProvider();

  it("POSTs a new issue and reads back what GitLab stored", async () => {
    receivedWrites = [];

    const created = await gitlab().createIssue(credential(), PROJECT, {
      title: "New backlight controller",
      description: "for the porch",
      assignees: ["ada"],
      labels: ["bug", "status::todo"],
      milestone: "90",
      parentEpicId: "77",
    });

    expect(receivedWrites).toHaveLength(1);
    expect(receivedWrites[0]?.method).toBe("POST");
    expect(receivedWrites[0]?.body).toEqual({
      title: "New backlight controller",
      description: "for the porch",
      labels: "bug,status::todo",
      milestone_id: 90,
      epic_id: 77,
      assignee_ids: [7],
    });
    // What GitLab stored, from its own answer — never the value that was typed.
    expect(created).toEqual({
      externalId: "20",
      number: 20,
      title: "New backlight controller",
      description: "for the porch",
      state: "open",
      url: "u/issues/20",
      labels: ["bug", "status::todo"],
      assignees: [{ login: "ada", name: null, avatarUrl: null }],
      milestone: { externalId: "90", title: "v1", startDate: null, dueDate: null },
    });
  });

  it("omits a key entirely when the seed did not carry it, the same absent-vs-empty rule updateIssue follows", async () => {
    receivedWrites = [];

    await gitlab().createIssue(credential(), PROJECT, { title: "Bare minimum" });

    expect(receivedWrites[0]?.body).toEqual({ title: "Bare minimum" });
  });

  it("puts due date, weight and confidential in the update body, with GitLab's own clear sentinels", async () => {
    // Clearing differs per field on GitLab: a due date clears with "" and a weight with null.
    receivedWrites = [];

    await gitlab().updateIssue(credential(), PROJECT, 3, {
      dueDate: null,
      weight: 5,
      confidential: true,
    });

    expect(receivedWrites[0]?.method).toBe("PUT");
    expect(receivedWrites[0]?.body).toEqual({ due_date: "", weight: 5, confidential: true });
  });

  it("puts due date, weight and confidential in the create body itself", async () => {
    // The three GitLab's POST /issues takes directly (user request 2026-08-30) — no follow-up call.
    receivedWrites = [];

    await gitlab().createIssue(credential(), PROJECT, {
      title: "Cold weather stall",
      dueDate: "2026-09-30",
      weight: 3,
      confidential: true,
    });

    expect(receivedWrites).toHaveLength(1);
    expect(receivedWrites[0]?.body).toEqual({
      title: "Cold weather stall",
      due_date: "2026-09-30",
      weight: 3,
      confidential: true,
    });
  });

  it("applies the time estimate and links after the issue exists, since create takes neither", async () => {
    receivedWrites = [];

    await gitlab().createIssue(credential(), PROJECT, {
      title: "Needs an estimate",
      timeEstimate: "2h",
      links: [{ issueNumber: 41, type: "blocks" }],
    });

    // The create itself carries neither key...
    expect(receivedWrites[0]?.body).toEqual({ title: "Needs an estimate" });
    // ...they are separate POSTs against the issue GitLab just returned.
    const paths = receivedWrites.map((w) => w.path);
    expect(paths.some((u) => u.includes("/issues/20/time_estimate"))).toBe(true);
    expect(paths.some((u) => u.includes("/issues/20/links"))).toBe(true);
    expect(receivedWrites.find((w) => w.path.includes("/time_estimate"))?.body).toEqual({
      duration: "2h",
    });
    expect(receivedWrites.find((w) => w.path.includes("/links"))?.body).toMatchObject({
      target_issue_iid: 41,
      link_type: "blocks",
    });
  });

  it("creates an epic with a fixed start/due date, the flag GitLab needs or it computes its own", async () => {
    // Sending a bare `start_date` is accepted and silently ignored on an epic with milestones —
    // the same "write that reports success and changes nothing" shape `updateIssue`'s own
    // comment documents for GitLab's `state` field.
    receivedWrites = [];

    const created = await gitlab().createEpic(credential(), GROUP, {
      title: "Q3 roadmap",
      description: "the big rocks",
      labels: ["priority::high"],
      startDate: "2026-07-01",
      dueDate: "2026-09-30",
    });

    expect(receivedWrites[0]?.method).toBe("POST");
    expect(receivedWrites[0]?.body).toEqual({
      title: "Q3 roadmap",
      description: "the big rocks",
      labels: "priority::high",
      start_date_is_fixed: true,
      start_date_fixed: "2026-07-01",
      due_date_is_fixed: true,
      due_date_fixed: "2026-09-30",
    });
    expect(created).toEqual({
      externalId: "900",
      iid: 12,
      title: "Q3 roadmap",
      url: "u/epics/12",
      state: "open",
      startDate: "2026-07-01",
      dueDate: "2026-09-30",
      groupRef: GROUP,
    });
  });

  it("clears a fixed date with null, and leaves GitLab's default alone when the seed omits it", async () => {
    receivedWrites = [];

    await gitlab().createEpic(credential(), GROUP, { title: "No dates", startDate: null });

    expect(receivedWrites[0]?.body).toEqual({
      title: "No dates",
      start_date_is_fixed: false,
    });
  });

  it("lists groups the token can create an epic in, scoped to Developer access or higher", async () => {
    receivedPaths = [];

    const groups = await gitlab().listGroups(credential());

    expect(groups).toEqual([
      { externalId: "55", fullPath: "acme/platform", name: "Platform", url: "u/acme/platform" },
      { externalId: "56", fullPath: "acme/design", name: "Design", url: "u/acme/design" },
    ]);
    // Developer access (30) is the floor GitLab requires to create an epic — listing every group
    // the token can merely read would offer a picker whose choices fail on Create.
    expect(receivedPaths.at(-1)).toContain("min_access_level=30");
  });

  it("lists a group's existing epics, for the parent-epic picker", async () => {
    const epics = await gitlab().listEpics(credential(), GROUP);

    expect(epics).toEqual([
      {
        externalId: "901",
        iid: 13,
        title: "Existing epic",
        url: "u/epics/13",
        state: "open",
        startDate: "2026-08-01",
        dueDate: "2026-09-01",
        groupRef: GROUP,
      },
    ]);
  });
});
