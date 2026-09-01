import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetScmCache, scmCacheStats } from "./cache.js";
import { scmFetch, scmFetchPaged } from "./http.js";

/**
 * Contract tests for the shared fetch layer, against a scripted fixture server rather than a live
 * API (Principle VI) — `Bun.serve` is what makes it possible to assert the things that matter
 * here, because every one of them is about *what was sent* and *how often*, not about what came
 * back. A mocked `fetch` returning canned bodies would pass while sending no `If-None-Match` at
 * all.
 *
 * The properties under test are the ones the caching layer must never break: the caller sees
 * exactly what an unconditional fetch would have returned, no token's answer reaches another
 * token, and no caller can corrupt a body a later caller receives.
 */

let server: ReturnType<typeof Bun.serve>;
let base: string;

/** Every request the fixture saw: method, path, and the two headers these tests assert on. */
let seen: Array<{ path: string; ifNoneMatch: string | null; auth: string }> = [];

/**
 * What the fixture answers with, set per test.
 *
 * A function of the request rather than a fixed body, because half of these cases are about the
 * server behaving differently on the second call than on the first.
 */
let respond: (req: Request, url: URL) => Response;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: `${url.pathname}${url.search}`,
        ifNoneMatch: req.headers.get("if-none-match"),
        auth: req.headers.get("authorization") ?? "",
      });
      return respond(req, url);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  seen = [];
  // A cache that outlived the test that filled it would make the next one assert against an
  // answer it never asked for — the exact failure this module's `resetScmCache` exists for.
  resetScmCache();
  respond = () => new Response("{}", { headers: { "content-type": "application/json" } });
});

const token = (value: string) => ({ Authorization: `Bearer ${value}` });

/** A JSON body with an `ETag`, which is the whole precondition for anything being cached. */
function tagged(body: unknown, etag: string): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", etag },
  });
}

describe("conditional requests", () => {
  it("revalidates with the tag it was given, and returns the held body on a 304", async () => {
    const rows = [{ id: 1, title: "Latch sticks" }];
    respond = (req) =>
      req.headers.get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : tagged(rows, '"v1"');

    const first = await scmFetch("github", `${base}/issues`, token("a"));
    const second = await scmFetch("github", `${base}/issues`, token("a"));

    // The point of the whole mechanism: the second read is indistinguishable from the first.
    expect(first).toEqual(rows);
    expect(second).toEqual(rows);
    // But it was a revalidation, not a re-download — which is what costs no rate-limit point.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.ifNoneMatch).toBeNull();
    expect(seen[1]?.ifNoneMatch).toBe('"v1"');
  });

  it("takes the new body when the tag no longer matches", async () => {
    const before = [{ id: 1, title: "Latch sticks" }];
    const after = [{ id: 1, title: "Latch sticks in the cold" }];
    respond = (req) =>
      req.headers.get("if-none-match") === '"v1"' ? tagged(after, '"v2"') : tagged(before, '"v1"');

    expect(await scmFetch("github", `${base}/issues`, token("a"))).toEqual(before);
    // A changed resource must answer with the change, not with what was held for it.
    expect(await scmFetch("github", `${base}/issues`, token("a"))).toEqual(after);
  });

  it("holds nothing for a response with no ETag, and sends no tag on the next read", async () => {
    const rows = [{ id: 7 }];
    respond = () =>
      new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });

    await scmFetch("github", `${base}/issues`, token("a"));
    await scmFetch("github", `${base}/issues`, token("a"));

    expect(scmCacheStats().entries).toBe(0);
    expect(seen.every((r) => r.ifNoneMatch === null)).toBe(true);
  });

  it("refetches unconditionally when a 304 arrives with nothing held for it", async () => {
    // A 304 for a tag we are not holding is what an eviction between request and reply looks
    // like. Returning the empty body would report a repository with no issues.
    let asked = 0;
    respond = () => {
      asked += 1;
      return asked === 1 ? new Response(null, { status: 304 }) : tagged([{ id: 3 }], '"v1"');
    };

    expect(await scmFetch("github", `${base}/issues`, token("a"))).toEqual([{ id: 3 }]);
    expect(asked).toBe(2);
  });
});

describe("credential isolation", () => {
  it("never serves one token's body to another", async () => {
    // The fixture is a private repository: each token is entitled to a different answer, and the
    // failure this guards against is the second caller being handed the first's (Principle IV).
    const bodies: Record<string, unknown> = {
      "Bearer a": [{ id: 1, title: "visible to a" }],
      "Bearer b": [{ id: 2, title: "visible to b" }],
    };
    respond = (req) => {
      const auth = req.headers.get("authorization") ?? "";
      if (req.headers.get("if-none-match") === `"${auth}"`)
        return new Response(null, { status: 304 });
      return tagged(bodies[auth], `"${auth}"`);
    };

    expect(await scmFetch("github", `${base}/repos/acme/secret`, token("a"))).toEqual([
      { id: 1, title: "visible to a" },
    ]);
    expect(await scmFetch("github", `${base}/repos/acme/secret`, token("b"))).toEqual([
      { id: 2, title: "visible to b" },
    ]);

    // B's read reached the server rather than being answered from A's entry, and carried no tag
    // of A's to revalidate against.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.auth).toBe("Bearer b");
    expect(seen[1]?.ifNoneMatch).toBeNull();
  });
});

describe("coalescing", () => {
  it("issues one request when two callers ask for the same thing at once", async () => {
    const rows = [{ id: 1 }];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = () => tagged(rows, '"v1"');

    // Both started before either can finish, which is the only state coalescing applies to.
    const both = Promise.all([
      scmFetch("github", `${base}/labels`, token("a")),
      gate.then(() => scmFetch("github", `${base}/labels`, token("a"))),
    ]);
    release();
    const [first, second] = await both;

    expect(first).toEqual(rows);
    expect(second).toEqual(rows);
    expect(seen).toHaveLength(1);
  });

  it("gives each joiner its own copy, so one caller cannot corrupt the other's", async () => {
    respond = () => tagged([{ id: 1 }], '"v1"');

    const [first, second] = (await Promise.all([
      scmFetch("github", `${base}/labels`, token("a")),
      scmFetch("github", `${base}/labels`, token("a")),
    ])) as [Array<{ id: number }>, Array<{ id: number }>];

    expect(first).not.toBe(second);
    first.push({ id: 99 });
    expect(second).toEqual([{ id: 1 }]);
  });

  it("does not pin later callers to a failed request", async () => {
    let asked = 0;
    respond = () => {
      asked += 1;
      return asked === 1 ? new Response("boom", { status: 500 }) : tagged([{ id: 1 }], '"v1"');
    };

    await expect(scmFetch("github", `${base}/labels`, token("a"))).rejects.toThrow();
    // The in-flight entry is cleared on rejection, so the next caller gets its own attempt.
    expect(await scmFetch("github", `${base}/labels`, token("a"))).toEqual([{ id: 1 }]);
  });
});

describe("the cached body is nobody's to mutate", () => {
  it("survives a caller sorting the array it was handed", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    respond = (req) =>
      req.headers.get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : tagged(rows, '"v1"');

    const first = (await scmFetch("github", `${base}/issues`, token("a"))) as Array<{ id: number }>;
    first.reverse();
    first.push({ id: 3 });

    // The 304 must answer with what the provider sent, not with what a previous caller left.
    expect(await scmFetch("github", `${base}/issues`, token("a"))).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("paging", () => {
  /** A page of `size` rows, numbered so the test can assert order as well as count. */
  const page = (n: number, size: number) =>
    Array.from({ length: size }, (_, i) => ({ id: (n - 1) * size + i + 1 }));

  const paged = (url: string) => (p: number) => `${url}?page=${p}`;

  it("stops at a short first page without asking for a second", async () => {
    respond = () => tagged(page(1, 1), '"p1"');

    const all = await scmFetchPaged("github", paged(`${base}/issues`), token("a"), 2, 50);

    expect(all).toEqual([{ id: 1 }]);
    expect(seen).toHaveLength(1);
  });

  it("reads pages 2..n at once when a Link header names the last one", async () => {
    respond = (_req, url) => {
      const n = Number(url.searchParams.get("page"));
      const res = tagged(page(n, 2), `"p${n}"`);
      // GitHub's RFC 8288 pagination. Only page 1's headers are read, but sending it on every
      // page is what the real API does.
      res.headers.set("link", `<${base}/issues?page=3>; rel="last"`);
      return res;
    };

    const all = await scmFetchPaged("github", paged(`${base}/issues`), token("a"), 2, 50);

    expect(all.map((r) => (r as { id: number }).id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.map((r) => r.path).sort()).toEqual([
      "/issues?page=1",
      "/issues?page=2",
      "/issues?page=3",
    ]);
  });

  it("reads the same way from GitLab's x-total-pages", async () => {
    respond = (_req, url) => {
      const n = Number(url.searchParams.get("page"));
      const res = tagged(page(n, 2), `"p${n}"`);
      res.headers.set("x-total-pages", "2");
      return res;
    };

    const all = await scmFetchPaged("gitlab", paged(`${base}/issues`), token("a"), 2, 50);

    expect(all.map((r) => (r as { id: number }).id)).toEqual([1, 2, 3, 4]);
    expect(seen).toHaveLength(2);
  });

  it("never fetches beyond the cap, however many pages the provider announces", async () => {
    respond = (_req, url) => {
      const n = Number(url.searchParams.get("page"));
      const res = tagged(page(n, 2), `"p${n}"`);
      res.headers.set("x-total-pages", "500");
      return res;
    };

    const all = await scmFetchPaged("gitlab", paged(`${base}/issues`), token("a"), 2, 3);

    expect(all).toHaveLength(6);
    expect(seen).toHaveLength(3);
  });

  it("walks sequentially when the provider announces nothing, ending on a short page", async () => {
    respond = (_req, url) => {
      const n = Number(url.searchParams.get("page"));
      return tagged(n < 3 ? page(n, 2) : [{ id: 5 }], `"p${n}"`);
    };

    const all = await scmFetchPaged("github", paged(`${base}/issues`), token("a"), 2, 50);

    expect(all.map((r) => (r as { id: number }).id)).toEqual([1, 2, 3, 4, 5]);
    // Four would mean it kept asking past the short page.
    expect(seen).toHaveLength(3);
  });

  it("still ends on a short page when the announced count was read before a backlog shifted", async () => {
    // The count is read from page 1, and rows can be deleted while pages 2..n are in flight. What
    // the provider just sent wins over what it said a moment ago — otherwise a shifted page's
    // repeats would be appended as though they were new rows.
    respond = (_req, url) => {
      const n = Number(url.searchParams.get("page"));
      const res = tagged(n === 2 ? [{ id: 3 }] : page(n, 2), `"p${n}"`);
      res.headers.set("x-total-pages", "3");
      return res;
    };

    const all = await scmFetchPaged("gitlab", paged(`${base}/issues`), token("a"), 2, 50);

    expect(all.map((r) => (r as { id: number }).id)).toEqual([1, 2, 3]);
  });
});
