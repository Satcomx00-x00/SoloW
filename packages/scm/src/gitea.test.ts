import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GiteaProvider } from "./gitea.js";
import { ScmProviderError } from "./types.js";

/**
 * Contract tests against a scripted fixture server — never a live Gitea API call (Principle VI).
 *
 * Gitea's API is deliberately GitHub-shaped, so what is worth pinning is the places it is
 * *nearly* the same: the `token` authorization scheme rather than a bearer, the mandatory base
 * URL, and the merged flag that replaces GitHub's `merged_at`. A driver written from memory of
 * the GitHub one gets all three wrong.
 */

let server: ReturnType<typeof Bun.serve>;
let receivedAuth: string[] = [];
let receivedPaths: string[] = [];
/** Every non-GET request, so the verb and the body are asserted rather than assumed. */
let receivedWrites: Array<{ method: string; path: string; body: unknown }> = [];

const REPO = "acme/gate";

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

      if (url.pathname === "/api/v1/user") return Response.json({ login: "tea" });

      if (url.pathname === "/api/v1/user/repos") {
        // Returned out of order on purpose: Gitea has no `sort=full_name`, so the driver sorts.
        return Response.json([
          {
            name: "zeta",
            full_name: "acme/zeta",
            description: null,
            default_branch: "main",
            private: true,
            html_url: "u/zeta",
            clone_url: "https://gitea.example.com/acme/zeta.git",
          },
          {
            name: "gate",
            full_name: REPO,
            description: "the gate",
            default_branch: "trunk",
            private: false,
            html_url: "u/gate",
            clone_url: "https://gitea.example.com/acme/gate.git",
          },
        ]);
      }

      if (url.pathname === `/api/v1/repos/${REPO}/issues`) {
        return Response.json([
          {
            id: 11,
            number: 3,
            title: "Backlight flickers",
            body: "at dusk",
            state: "open",
            html_url: "u/issues/3",
          },
          // A pull request, which Gitea returns from the issues endpoint exactly as GitHub does.
          {
            id: 12,
            number: 4,
            title: "A change, not an issue",
            body: null,
            state: "open",
            html_url: "u/pulls/4",
            pull_request: { merged: false },
          },
        ]);
      }

      if (url.pathname === `/api/v1/repos/${REPO}/pulls`) {
        return Response.json([
          {
            id: 21,
            number: 7,
            title: "Open one",
            state: "open",
            merged: false,
            html_url: "u/pulls/7",
            head: { ref: "feat" },
            base: { ref: "trunk" },
            user: { login: "dev" },
          },
          {
            id: 22,
            number: 8,
            title: "Merged one",
            // Gitea keeps `state: "closed"` on a merged PR and says so with `merged`.
            state: "closed",
            merged: true,
            html_url: "u/pulls/8",
            head: { ref: "fix" },
            base: { ref: "trunk" },
            user: null,
          },
        ]);
      }

      if (url.pathname === `/api/v1/repos/${REPO}/labels`) {
        return Response.json([
          { name: "bug", color: "d73a4a", description: "broken" },
          { name: "prefixed", color: "#00ff00", description: null },
          { name: "colourless", color: null, description: null },
        ]);
      }

      if (url.pathname === `/api/v1/repos/${REPO}/branches`) {
        return Response.json([
          { name: "trunk", commit: { id: "aaa", timestamp: "2026-01-01T00:00:00Z" } },
          { name: "feat", commit: { id: "bbb" } },
        ]);
      }

      if (url.pathname === `/api/v1/repos/${REPO}`) {
        return Response.json({ default_branch: "trunk" });
      }

      if (url.pathname === `/api/v1/repos/${REPO}/issues/10/labels`) {
        return Response.json([]);
      }
      if (url.pathname === `/api/v1/repos/${REPO}/issues/10`) {
        if (req.method === "PATCH") {
          const patch = (await req.json()) as Record<string, unknown>;
          return Response.json({
            id: 1,
            number: 10,
            title: patch.title ?? "Latch",
            body: patch.body ?? null,
            state: patch.state ?? "open",
            html_url: "u/i/10",
            assignees: ((patch.assignees as string[]) ?? []).map((login) => ({ login })),
            labels: [{ name: "bug" }],
            milestone: patch.milestone ? { id: patch.milestone, title: "v1", due_on: null } : null,
          });
        }
        return Response.json({
          id: 1,
          number: 10,
          title: "Latch",
          body: "sticks",
          state: "open",
          html_url: "u/i/10",
          assignees: [{ login: "ada", full_name: "Ada", avatar_url: "a.png" }],
          labels: [{ name: "bug" }],
          milestone: { id: 3, title: "v1", due_on: null },
        });
      }
      if (url.pathname === `/api/v1/repos/${REPO}/assignees`) {
        return Response.json([{ login: "ada", full_name: "Ada", avatar_url: "a.png" }]);
      }
      if (url.pathname === `/api/v1/repos/${REPO}/milestones`) {
        return Response.json([{ id: 3, title: "v1", due_on: null }]);
      }

      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

const gitea = new GiteaProvider();
const credential = () => ({ token: "tok", baseUrl: `http://localhost:${server.port}` });

describe("GiteaProvider", () => {
  it("authenticates with Gitea's own scheme, not a bearer", async () => {
    // `Bearer` works on newer Gitea and not on older; `token` works on every version.
    receivedAuth = [];
    expect(await gitea.authenticate(credential())).toEqual({ ok: true });
    expect(receivedAuth.at(-1)).toBe("token tok");
  });

  it("refuses to guess a host, because there is no hosted Gitea to guess", async () => {
    const result = await gitea.authenticate({ token: "tok", baseUrl: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("base URL");
  });

  it("reports a failed call as a typed provider error, without the token in it", async () => {
    const bad = { token: "sk-secret", baseUrl: `http://localhost:${server.port}` };
    const failing = gitea.listIssues(bad, "acme/missing");
    await expect(failing).rejects.toBeInstanceOf(ScmProviderError);
    await expect(failing).rejects.not.toThrow(/sk-secret/);
  });

  it("sorts repositories by full name, since Gitea will not do it", async () => {
    const repos = await gitea.listRepositories(credential());
    expect(repos.map((r) => r.fullName)).toEqual(["acme/gate", "acme/zeta"]);
    expect(repos[0]).toMatchObject({
      name: "gate",
      defaultBranch: "trunk",
      isPrivate: false,
      cloneUrl: "https://gitea.example.com/acme/gate.git",
    });
  });

  it("keeps change requests out of the issue list", async () => {
    // The bug this prevents: a change request offered as an importable Issue, so a Task gets
    // opened against the wrong thing.
    const issues = await gitea.listIssues(credential(), REPO);
    expect(issues.map((i) => i.number)).toEqual([3]);
    expect(issues[0]).toMatchObject({
      externalId: "11",
      title: "Backlight flickers",
      state: "open",
    });
  });

  it("says nothing about a hierarchy Gitea does not have", async () => {
    // Absent, not null. Gitea has no sub-issue or epic concept, so it never *reports* that an
    // issue has no parent — and the mirror reads the difference: an absent parent leaves an
    // established edge alone, a null one erases it (F23 FR-7). A driver that answered `null`
    // here would un-nest every Gitea row on every poll.
    const issues = await gitea.listIssues(credential(), REPO);
    expect(issues.every((i) => !("parentExternalId" in i))).toBe(true);
  });

  it("reports no links even when asked, rather than reporting there are none", async () => {
    // Gitea has no endpoint for which pull requests reference an issue. Opting in therefore
    // costs nothing and answers nothing — and `[]` would be the one wrong answer, a row
    // claiming nothing is in flight on a provider that was never asked.
    receivedPaths = [];
    const issues = await gitea.listIssues(credential(), REPO, { linkedChangeRequests: true });

    expect(issues.every((i) => !("linkedChangeRequests" in i))).toBe(true);
    expect(receivedPaths).toHaveLength(1);
  });

  it("reads merged off the flag, not off the state", async () => {
    // Gitea leaves a merged pull request at `state: "closed"`. Trusting the state would report
    // every merged change as merely closed.
    const crs = await gitea.listChangeRequests(credential(), REPO);
    expect(crs.map((c) => c.state)).toEqual(["open", "merged"]);
    expect(crs[0]).toMatchObject({ headRef: "feat", baseRef: "trunk", authorLogin: "dev" });
    expect(crs[1]?.authorLogin).toBeNull();
  });

  it("normalises label colours to one swatch format", async () => {
    const labels = await gitea.listLabels(credential(), REPO);
    expect(labels.map((l) => l.color)).toEqual(["#d73a4a", "#00ff00", null]);
  });

  it("marks the default branch from the repository, and keeps the commit time when there is one", async () => {
    const branches = await gitea.listBranches(credential(), REPO);
    expect(branches).toEqual([
      { name: "trunk", isDefault: true, headSha: "aaa", headCommittedAt: "2026-01-01T00:00:00Z" },
      { name: "feat", isDefault: false, headSha: "bbb", headCommittedAt: null },
    ]);
  });

  it("puts everything under /api/v1, which is where Gitea lives on every host", async () => {
    receivedPaths = [];
    await gitea.listIssues(credential(), REPO);
    expect(receivedPaths.at(-1)?.startsWith("/api/v1/")).toBe(true);
  });
});

describe("writing an issue back to Gitea", () => {
  it("sends a PATCH, and only the keys the patch carries", async () => {
    receivedWrites = [];

    await gitea.updateIssue(credential(), REPO, 10, { title: "Renamed" });

    expect(receivedWrites).toHaveLength(1);
    expect(receivedWrites[0]?.method).toBe("PATCH");
    expect(receivedWrites[0]?.body).toEqual({ title: "Renamed" });
  });

  it("writes labels through their own endpoint, and before the issue itself", async () => {
    // Gitea's issue PATCH ignores labels entirely. Sending them first means a failure there
    // leaves the issue untouched rather than half-edited — a title that landed beside labels that
    // did not is the state hardest to reason about afterwards.
    receivedWrites = [];

    await gitea.updateIssue(credential(), REPO, 10, { title: "Renamed", labels: ["bug"] });

    expect(receivedWrites.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PUT /api/v1/repos/${REPO}/issues/10/labels`,
      `PATCH /api/v1/repos/${REPO}/issues/10`,
    ]);
    // And the labels never travel in the issue patch, where they would be silently dropped.
    expect(receivedWrites[1]?.body).toEqual({ title: "Renamed" });
  });

  it("clears a milestone with 0, which is what Gitea takes", async () => {
    receivedWrites = [];

    await gitea.updateIssue(credential(), REPO, 10, { milestone: null });

    expect(receivedWrites[0]?.body).toEqual({ milestone: 0 });
  });

  it("reads one issue with what a listing drops", async () => {
    const issue = await gitea.getIssue(credential(), REPO, 10);

    expect(issue.assignees?.[0]?.name).toBe("Ada");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.milestone?.externalId).toBe("3");
  });
});
