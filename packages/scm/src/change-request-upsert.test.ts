import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { GiteaProvider } from "./gitea.js";
import { GithubProvider } from "./github.js";
import { GitlabProvider } from "./gitlab.js";

/**
 * `upsertChangeRequest` on all three drivers, against one stateful fixture server (A1).
 *
 * The properties under test are the same for each provider, which is why they share a file: a
 * second call for the same branch updates rather than duplicates, and the verbs are the right
 * ones (a PATCH sent as a GET would answer 200 with the unchanged request and look like success).
 */

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
/** Open requests the fixture holds, in the neutral shape; each route maps it to its own. */
let open: Array<{
  n: number;
  head: string;
  base: string;
  title: string;
  body: string;
  /** The repository the head branch lives in; a fork's request names its own. */
  headRepo?: string;
}> = [];
let server: ReturnType<typeof Bun.serve>;

const row = (r: (typeof open)[number], base: string) => ({
  id: 100 + r.n,
  iid: r.n,
  number: r.n,
  title: r.title,
  state: "open",
  opened: true,
  merged: false,
  merged_at: null,
  html_url: `${base}/pr/${r.n}`,
  web_url: `${base}/pr/${r.n}`,
  head: { ref: r.head, repo: { full_name: r.headRepo ?? "acme/gate" } },
  base: { ref: r.base },
  source_branch: r.head,
  target_branch: r.base,
  user: { login: "dev" },
  author: { username: "dev" },
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const origin = url.origin;
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      calls.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
      const json = (v: unknown) => Response.json(v);
      const path = decodeURIComponent(url.pathname);

      // Repository lookups, for the default branch.
      if (/\/(repos|projects)\/[^/]+(\/[^/]+)?$/.test(path) && req.method === "GET") {
        return json({
          id: 1,
          name: "gate",
          full_name: "acme/gate",
          path_with_namespace: "acme/gate",
          description: null,
          default_branch: "trunk",
          private: true,
          visibility: "private",
          html_url: `${origin}/acme/gate`,
          web_url: `${origin}/acme/gate`,
          clone_url: `${origin}/acme/gate.git`,
          http_url_to_repo: `${origin}/acme/gate.git`,
        });
      }

      const list = /\/(pulls|merge_requests)$/.test(path);
      const one = path.match(/\/(?:pulls|merge_requests)\/(\d+)$/);
      if (list && req.method === "GET") {
        const head =
          url.searchParams.get("head")?.split(":")[1] ?? url.searchParams.get("source_branch");
        const rows = open.filter((r) => !head || r.head === head).map((r) => row(r, origin));
        // Gitea pages with `limit`/`page`, and a server caps `limit` at its own maximum (50 by
        // default) whatever the client asked for, so the fixture does too.
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 0), 50);
        const page = Number(url.searchParams.get("page") ?? 1);
        return json(limit ? rows.slice((page - 1) * limit, page * limit) : rows);
      }
      if (list && req.method === "POST") {
        const b = body as Record<string, string>;
        const r = {
          n: open.length + 1,
          head: b.head ?? b.source_branch ?? "",
          base: b.base ?? b.target_branch ?? "",
          title: b.title ?? "",
          body: b.body ?? b.description ?? "",
        };
        open.push(r);
        return json(row(r, origin));
      }
      if (one && (req.method === "PATCH" || req.method === "PUT")) {
        const r = open.find((x) => x.n === Number(one[1]));
        if (!r) return new Response("nope", { status: 404 });
        const b = body as Record<string, string>;
        r.title = b.title ?? r.title;
        r.body = b.body ?? b.description ?? r.body;
        return json(row(r, origin));
      }
      return new Response("unexpected", { status: 500 });
    },
  });
});

afterAll(() => server.stop(true));
beforeEach(() => {
  calls = [];
  open = [];
});

const credential = () => ({ token: "tok", baseUrl: `http://localhost:${server.port}` });
const input = { head: "solow/task-1", title: "Fix it", body: "Because." };

const drivers = [
  { name: "github", make: () => new GithubProvider(), update: "PATCH", create: "/pulls" },
  { name: "gitlab", make: () => new GitlabProvider(), update: "PUT", create: "/merge_requests" },
  { name: "gitea", make: () => new GiteaProvider(), update: "PATCH", create: "/pulls" },
] as const;

for (const d of drivers) {
  describe(`${d.name} upsertChangeRequest`, () => {
    it("creates against the default branch when none is open", async () => {
      const out = await d.make().upsertChangeRequest(credential(), "acme/gate", input);
      expect(out.created).toBe(true);
      expect(out.changeRequest.headRef).toBe("solow/task-1");
      expect(out.changeRequest.baseRef).toBe("trunk");
      expect(out.changeRequest.url).toContain("/pr/1");
      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toContain(d.create);
    });

    it("honours an explicit base without asking the repository", async () => {
      const out = await d
        .make()
        .upsertChangeRequest(credential(), "acme/gate", { ...input, base: "release" });
      expect(out.changeRequest.baseRef).toBe("release");
    });

    it("finds the open one instead of opening a second, and leaves what people wrote on it", async () => {
      await d.make().upsertChangeRequest(credential(), "acme/gate", input);
      // A reviewer retitles the request and rewrites its description on the provider.
      const [first] = open;
      if (!first) throw new Error("fixture did not record the request");
      first.title = "Fix it (edited by a human)";
      first.body = "Hand-written notes.";
      calls = [];
      const out = await d
        .make()
        .upsertChangeRequest(credential(), "acme/gate", { ...input, title: "Fix it again" });
      expect(out.created).toBe(false);
      expect(out.changeRequest.number).toBe(1);
      expect(out.changeRequest.title).toBe("Fix it (edited by a human)");
      expect(first.body).toBe("Hand-written notes.");
      expect(open).toHaveLength(1);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(calls.some((c) => c.method === d.update)).toBe(false);
    });

    if (d.name === "gitea") {
      it("does not take a fork's request for a branch of the same name as its own", async () => {
        // Anyone can open a request from their fork's `solow/task-1`. Taken for ours, the link
        // would point at their code, and the push to our branch would never reach a request.
        open.push({
          n: 1,
          head: input.head,
          base: "trunk",
          title: "Theirs",
          body: "",
          headRepo: "mallory/gate",
        });
        const out = await d.make().upsertChangeRequest(credential(), "acme/gate", input);
        expect(out.created).toBe(true);
        expect(out.changeRequest.number).toBe(2);
        expect(calls.some((c) => c.method === "POST")).toBe(true);
      });
    }

    it("finds the open one when many other requests are open", async () => {
      for (let n = 1; n <= 120; n++) {
        open.push({ n, head: `feature/${n}`, base: "trunk", title: `Other ${n}`, body: "" });
      }
      open.push({ n: 121, head: input.head, base: "trunk", title: "Ours", body: "" });
      const out = await d.make().upsertChangeRequest(credential(), "acme/gate", input);
      expect(out.created).toBe(false);
      expect(out.changeRequest.number).toBe(121);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    });
  });
}
