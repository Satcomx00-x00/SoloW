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
/** One entry per GraphQL call, holding the node ids it asked about. */
let parentQueries: string[][] = [];
/**
 * `METHOD path` per request, and the parsed body of each write.
 *
 * The verb is asserted, not assumed. A write sent as a GET is answered 200 with the *unchanged*
 * object by every provider here, so the driver reads back something plausible and nothing reports
 * a failure — a no-op that looks exactly like a success. GitLab shipped precisely that.
 */
let receivedWrites: Array<{ method: string; path: string; body: unknown }> = [];

/**
 * What the fixture's GraphQL answers for a node id: the issue's database id, and its parent's.
 *
 * Keyed by node id because that is what the driver sends, and answering with `databaseId` is the
 * point of the query — a parent named in the node-id space would match no child's `externalId`.
 */
const PARENT_BY_NODE: Record<string, { databaseId: number; parent: number | null }> = {
  I_1: { databaseId: 1, parent: null },
  I_50: { databaseId: 50, parent: null },
  I_51: { databaseId: 51, parent: 50 },
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      receivedAuth.push(req.headers.get("authorization") ?? "");
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

      /** GitHub's GraphQL root, which is where the sub-issue hierarchy lives (issue #127). */
      if (url.pathname === "/api/graphql") {
        const body = (await req.json()) as { variables?: { ids?: string[] } };
        const ids = body.variables?.ids ?? [];
        parentQueries.push(ids);
        // A GraphQL budget exhausted mid-listing, which must not be read as "no parents".
        if (ids.includes("I_throttled")) {
          return new Response("API rate limit exceeded", { status: 429 });
        }
        // A GitHub Enterprise Server old enough not to know the field at all: a 200 carrying an
        // `errors` array, which is GraphQL's way of failing.
        if (ids.includes("I_legacy")) {
          return Response.json({
            errors: [{ message: "Field 'parent' doesn't exist on type 'Issue'" }],
          });
        }
        return Response.json({
          data: {
            nodes: ids.map((id) => {
              const found = PARENT_BY_NODE[id];
              if (!found) return null;
              return {
                databaseId: found.databaseId,
                parent: found.parent ? { databaseId: found.parent } : null,
              };
            }),
          },
        });
      }

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
            clone_url: "https://github.com/acme/gate.git",
          },
          {
            name: "docs",
            full_name: "acme/docs",
            description: null,
            default_branch: null,
            private: false,
            html_url: "u/acme/docs",
            clone_url: "https://github.com/acme/docs.git",
          },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/gate/issues") {
        return Response.json([
          {
            id: 1,
            node_id: "I_1",
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
      /**
       * A repository whose issues carry provider-linked pull requests (issue #128). Separate from
       * `acme/gate` so the existing issue-listing fixture keeps asserting the case where the
       * timeline cannot be read at all.
       */
      if (url.pathname === "/api/v3/repos/acme/linked/issues") {
        return Response.json([
          {
            id: 30,
            number: 10,
            title: "Several in flight",
            body: null,
            state: "open",
            html_url: "u/issues/10",
          },
          {
            id: 31,
            number: 11,
            title: "Nothing in flight",
            body: null,
            state: "open",
            html_url: "u/issues/11",
          },
        ]);
      }
      /** An epic and its sub-issue, which is the whole of GitHub's hierarchy (issue #127). */
      if (url.pathname === "/api/v3/repos/acme/nested/issues") {
        return Response.json([
          {
            id: 50,
            node_id: "I_50",
            number: 1,
            title: "The epic",
            body: null,
            state: "open",
            html_url: "u/issues/1",
          },
          {
            id: 51,
            node_id: "I_51",
            number: 2,
            title: "A sub-issue of it",
            body: null,
            state: "open",
            html_url: "u/issues/2",
          },
        ]);
      }
      /** A GHES with no sub-issues: the issues read fine, the hierarchy query does not. */
      if (url.pathname === "/api/v3/repos/acme/legacy/issues") {
        return Response.json([
          {
            id: 60,
            node_id: "I_legacy",
            number: 1,
            title: "On an older Enterprise Server",
            body: null,
            state: "open",
            html_url: "u/issues/1",
          },
        ]);
      }
      /**
       * Issues whose *timelines* are throttled — the enrichment failure that matters. More of
       * them than the driver's concurrency window, so a test can see the fan-out stop.
       */
      if (url.pathname === "/api/v3/repos/acme/busy/issues") {
        return Response.json(
          Array.from({ length: 8 }, (_unused, i) => ({
            id: 70 + i,
            node_id: `I_${70 + i}`,
            number: i + 1,
            title: `Issue ${i + 1}`,
            body: null,
            state: "open",
            html_url: `u/issues/${i + 1}`,
          })),
        );
      }
      if (url.pathname.startsWith("/api/v3/repos/acme/busy/issues/")) {
        return new Response("You have exceeded a secondary rate limit", { status: 429 });
      }
      /** The GraphQL hierarchy call is throttled, not the REST listing. */
      if (url.pathname === "/api/v3/repos/acme/throttled/issues") {
        return Response.json([
          {
            id: 80,
            node_id: "I_throttled",
            number: 1,
            title: "Read while the budget was gone",
            body: null,
            state: "open",
            html_url: "u/issues/1",
          },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/linked/issues/10/timeline") {
        const pull = (
          id: number,
          number: number,
          title: string,
          state: string,
          mergedAt: string | null,
        ) => ({
          event: "cross-referenced",
          source: {
            issue: {
              id,
              number,
              title,
              state,
              html_url: `u/pull/${number}`,
              pull_request: { merged_at: mergedAt },
            },
          },
        });
        return Response.json([
          { event: "labeled" },
          // A cross-reference from an ordinary issue, which is not a change request.
          {
            event: "cross-referenced",
            source: { issue: { id: 99, number: 99, title: "Another issue", state: "open" } },
          },
          pull(40, 5, "Open PR", "open", null),
          // The same pull request, mentioned twice — one badge, not two.
          pull(40, 5, "Open PR", "open", null),
          pull(41, 6, "Merged PR", "closed", "2026-01-01T00:00:00Z"),
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/linked/issues/11/timeline") {
        return Response.json([{ event: "labeled" }]);
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
      if (url.pathname === "/api/v3/repos/acme/gate/labels") {
        return Response.json([
          { name: "bug", color: "d73a4a", description: "Something isn't working" },
          { name: "no-description", color: null, description: null },
        ]);
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

      /** One issue, read alone — carrying what a listing drops. */
      if (url.pathname === "/api/v3/repos/acme/gate/issues/10") {
        if (req.method === "PATCH") {
          const patch = (await req.json()) as Record<string, unknown>;
          return Response.json({
            id: 1,
            number: 10,
            // What GitHub *stored*, deliberately not what was sent: the driver must read its
            // answer back rather than echo the request.
            title: patch.title === undefined ? "Real issue" : `${patch.title} (normalised)`,
            body: patch.body === undefined ? "from GitHub" : patch.body,
            state: patch.state ?? "open",
            html_url: "https://github.com/acme/gate/issues/10",
            assignees:
              patch.assignees === undefined
                ? [{ login: "ada", name: "Ada", avatar_url: null }]
                : (patch.assignees as string[]).map((login) => ({ login, name: null })),
            labels:
              patch.labels === undefined
                ? [{ name: "bug" }]
                : (patch.labels as string[]).map((name) => ({ name })),
            milestone:
              patch.milestone === undefined || patch.milestone === null
                ? null
                : { number: patch.milestone, title: "v1", due_on: null },
          });
        }
        return Response.json({
          id: 1,
          number: 10,
          title: "Real issue",
          body: "from GitHub",
          state: "open",
          html_url: "https://github.com/acme/gate/issues/10",
          assignees: [{ login: "ada", name: "Ada", avatar_url: "a.png" }],
          labels: [{ name: "bug" }, { name: "hardware" }],
          milestone: { number: 4, title: "v1", due_on: "2026-09-01T00:00:00Z" },
          updated_at: "2026-08-20T00:00:00Z",
        });
      }
      if (url.pathname === "/api/v3/repos/acme/gate/assignees") {
        return Response.json([
          { login: "ada", name: "Ada Lovelace", avatar_url: "a.png" },
          { login: "grace", name: null, avatar_url: null },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/gate/milestones") {
        return Response.json([
          { number: 4, title: "v1", due_on: "2026-09-01T00:00:00Z" },
          { number: 5, title: "v2", due_on: null },
        ]);
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
        // GitHub answered for this issue and said it has no parent. Null is that answer; the
        // absence of the key would be a different one (issue #127).
        parentExternalId: null,
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

  it("mirrors the pull requests GitHub links to an issue, once each", async () => {
    // #128 AC-1: number, title, state and merge time, from the provider's own timeline. Deduped
    // because an issue mentioned in three comments is one pull request, not three.
    const issues = await new GithubProvider().listIssues(credential(), "acme/linked", {
      linkedChangeRequests: true,
    });
    expect(issues[0]?.linkedChangeRequests).toEqual([
      {
        externalId: "40",
        number: 5,
        title: "Open PR",
        state: "open",
        url: "u/pull/5",
        mergedAt: null,
      },
      {
        externalId: "41",
        number: 6,
        title: "Merged PR",
        // `merged_at` overrides GitHub's raw "closed": a merged PR reported as closed is the
        // staleness this column exists to remove.
        state: "merged",
        url: "u/pull/6",
        mergedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("reports an issue with no linked pull request as an empty list, not as absent", async () => {
    // The distinction the table renders: "nothing is in flight" is an answer, and it must not be
    // confused with "this provider does not report links".
    const issues = await new GithubProvider().listIssues(credential(), "acme/linked", {
      linkedChangeRequests: true,
    });
    expect(issues[1]?.linkedChangeRequests).toEqual([]);
  });

  it("omits the links entirely when the timeline cannot be read", async () => {
    // Guards the failure that would blank a column: `acme/gate` has no timeline fixture, so the
    // side call 404s. Omitting leaves the sync holding the links it last confirmed; an empty
    // array would have the row claim nothing is in flight because one request failed.
    const issues = await new GithubProvider().listIssues(credential(), "acme/gate", {
      linkedChangeRequests: true,
    });
    expect(issues[0] && "linkedChangeRequests" in issues[0]).toBe(false);
  });

  describe("the per-issue enrichment is something a caller asks for (issue #128)", () => {
    it("reads no timeline at all unless the links were asked for", async () => {
      // The cost this removes: every caller — the connect-time auto-import over every repository
      // the token can see, the import preview — used to pay one request per issue to fill a
      // column only the planning table reads.
      receivedPaths = [];
      const issues = await new GithubProvider().listIssues(credential(), "acme/linked");

      expect(issues).toHaveLength(2);
      expect(receivedPaths.filter((p) => p.includes("/timeline"))).toEqual([]);
      // Unknown, not empty: a caller that did not ask has not been told there are none.
      expect(issues.every((i) => !("linkedChangeRequests" in i))).toBe(true);
    });

    it("fails the listing when the provider throttles the enrichment", async () => {
      // The laundering this prevents (issue #128 review): a 429 on the timeline call used to be
      // swallowed, so a throttled poll reported issues with no links and advanced its watermark
      // past them — a rate limit turned into permanent missing data that reads like the truth.
      const failing = new GithubProvider().listIssues(credential(), "acme/busy", {
        linkedChangeRequests: true,
      });

      await expect(failing).rejects.toBeInstanceOf(ScmProviderError);
      // The status has to survive into the message: the orchestrator's backoff reads it there,
      // and that is what marks the repository stale instead of current.
      await expect(failing).rejects.toThrow(/429/);
    });

    it("never answers a throttled enrichment with an empty link list", async () => {
      // The property stated as the caller sees it, and independently of *how* the driver
      // refuses: whatever comes back, no row may claim "nothing is in flight" on the strength of
      // a request the provider would not serve. `[]` is a fact; a 429 is not one.
      const issues = await new GithubProvider()
        .listIssues(credential(), "acme/busy", { linkedChangeRequests: true })
        .catch(() => []);

      expect(issues.some((i) => i.linkedChangeRequests !== undefined)).toBe(false);
    });

    it("stops fanning out once the provider has said slow down", async () => {
      // Eight issues, a window of five: without the short-circuit every one of them spends a
      // request on a token that has already been throttled, which is how a secondary rate limit
      // becomes a longer one.
      receivedPaths = [];
      await new GithubProvider()
        .listIssues(credential(), "acme/busy", { linkedChangeRequests: true })
        .catch(() => undefined);

      const timelines = receivedPaths.filter((p) => p.includes("/busy/issues/"));
      expect(timelines.length).toBeGreaterThan(0);
      expect(timelines.length).toBeLessThan(8);
    });
  });

  describe("the issue hierarchy (spec F23 FR-7, issue #127)", () => {
    it("reports a sub-issue's parent in the id space its children are matched in", async () => {
      // The defect this closes: nothing populated this field, so `external_parent_id` was null on
      // every row and no epic, chevron or rollup could ever render.
      const issues = await new GithubProvider().listIssues(credential(), "acme/nested");

      expect(issues.map((i) => i.parentExternalId)).toEqual([null, "50"]);
      // The parent is named by the same id the epic itself carries — a node id here would match
      // no row at all.
      expect(issues[1]?.parentExternalId).toBe(issues[0]?.externalId);
    });

    it("resolves a whole page's parents in one request, not one per issue", async () => {
      // The reason this is GraphQL and not REST's sub-issue endpoint: the cost is per listing,
      // which is what makes it affordable to do unconditionally.
      parentQueries = [];
      await new GithubProvider().listIssues(credential(), "acme/nested");

      expect(parentQueries).toHaveLength(1);
      expect(parentQueries[0]).toEqual(["I_50", "I_51"]);
    });

    it("omits the parent, rather than reporting none, where the provider cannot answer", async () => {
      // An Enterprise Server with no sub-issues. Reporting `null` would be GateControl asserting
      // the issue has no parent, and the mirror would erase an edge on every poll.
      const issues = await new GithubProvider().listIssues(credential(), "acme/legacy");

      expect(issues).toHaveLength(1);
      expect(issues[0] && "parentExternalId" in issues[0]).toBe(false);
    });

    it("fails the listing when the hierarchy query is throttled", async () => {
      // Same rule as the links: a throttle is not an answer. Degrading it to "unknown" would let
      // the watermark advance past issues whose hierarchy was never read.
      const failing = new GithubProvider().listIssues(credential(), "acme/throttled");

      await expect(failing).rejects.toBeInstanceOf(ScmProviderError);
      await expect(failing).rejects.toThrow(/429/);
    });
  });

  it("marks the branch matching the repo's default_branch as isDefault", async () => {
    const branches = await new GithubProvider().listBranches(credential(), "acme/gate");
    expect(branches).toEqual([
      { name: "main", isDefault: true, headSha: "abc123", headCommittedAt: null },
      { name: "feat", isDefault: false, headSha: "def456", headCommittedAt: null },
    ]);
  });

  it("maps GitHub's un-prefixed label color to #RRGGBB", async () => {
    const labels = await new GithubProvider().listLabels(credential(), "acme/gate");
    expect(labels).toEqual([
      { name: "bug", color: "#d73a4a", description: "Something isn't working" },
      { name: "no-description", color: null, description: null },
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
      cloneUrl: "https://github.com/acme/gate.git",
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

  it("reports the clone URL the provider gives, with no credential in it", async () => {
    const repos = await new GithubProvider().listRepositories(credential());
    // Importing stores this verbatim as the Repository's location, so a token here would be a
    // token in the database and in every `git remote -v` afterwards (Principle IV).
    expect(repos[0]?.cloneUrl).toBe("https://github.com/acme/gate.git");
    expect(repos.every((r) => !r.cloneUrl.includes("gh-pat-secret"))).toBe(true);
    expect(repos.every((r) => !r.cloneUrl.includes("@"))).toBe(true);
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

describe("writing an issue back to the provider", () => {
  const github = () => new GithubProvider();

  it("reads one issue in full, including what a listing drops", async () => {
    // A listing omits assignees, labels and the milestone on purpose — `ExternalIssue` keeps
    // "absent" different from "empty". An editor is the case that needs them.
    const issue = await github().getIssue(credential(), "acme/gate", 10);

    expect(issue.title).toBe("Real issue");
    expect(issue.assignees?.map((u) => u.login)).toEqual(["ada"]);
    expect(issue.labels).toEqual(["bug", "hardware"]);
    expect(issue.milestone?.title).toBe("v1");
  });

  it("sends a PATCH, not a GET — a write that reads is a no-op that looks like a success", async () => {
    receivedWrites = [];

    await github().updateIssue(credential(), "acme/gate", 10, { title: "Renamed" });

    expect(receivedWrites).toHaveLength(1);
    expect(receivedWrites[0]?.method).toBe("PATCH");
    expect(receivedWrites[0]?.path).toBe("/api/v3/repos/acme/gate/issues/10");
  });

  it("answers with what the provider stored, never with what was sent", async () => {
    // F23 NFR-7. A provider may normalise, truncate or refuse part of a value; rendering the
    // typed value back would show the operator their own input as though it were saved.
    const stored = await github().updateIssue(credential(), "acme/gate", 10, { title: "Renamed" });

    expect(stored.title).toBe("Renamed (normalised)");
  });

  it("sends only the keys the patch carries, so an editor cannot revert what it never showed", async () => {
    // `assignees: []` un-assigns everyone; no `assignees` key leaves them alone. A form that
    // posted itself whole would silently overwrite a colleague's edit to a field it did not draw.
    receivedWrites = [];

    await github().updateIssue(credential(), "acme/gate", 10, { state: "closed" });

    expect(receivedWrites[0]?.body).toEqual({ state: "closed" });
  });

  it("distinguishes clearing a milestone from leaving it alone", async () => {
    receivedWrites = [];

    await github().updateIssue(credential(), "acme/gate", 10, { milestone: null });
    await github().updateIssue(credential(), "acme/gate", 10, { milestone: "5" });

    expect(receivedWrites[0]?.body).toEqual({ milestone: null });
    // A number, because GitHub identifies a milestone by its number within the repository.
    expect(receivedWrites[1]?.body).toEqual({ milestone: 5 });
  });

  it("empties the assignees when asked to, rather than treating empty as absent", async () => {
    receivedWrites = [];

    const stored = await github().updateIssue(credential(), "acme/gate", 10, { assignees: [] });

    expect(receivedWrites[0]?.body).toEqual({ assignees: [] });
    expect(stored.assignees).toEqual([]);
  });

  it("offers the people the provider says can be assigned, not a free-text login", async () => {
    // Assigning someone without access is refused by every provider, so a picker that offered it
    // would be a picker that lies.
    const users = await github().listAssignableUsers(credential(), "acme/gate");

    expect(users.map((u) => u.login)).toEqual(["ada", "grace"]);
    expect(users[1]?.name).toBeNull();
  });

  it("lists closed milestones too, or the current value would render blank", async () => {
    const milestones = await github().listMilestones(credential(), "acme/gate");

    expect(milestones.map((m) => m.title)).toEqual(["v1", "v2"]);
    expect(receivedPaths.at(-1)).toContain("state=all");
  });
});
