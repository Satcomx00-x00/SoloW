import { afterEach, describe, expect, it } from "bun:test";
import { orchestratorHealthReport } from "@solow/contracts";
import { engineHealthUrl, handleHealthGet, probeEngine } from "./health.js";

describe("engineHealthUrl", () => {
  it("asks the self-hosted server the launchers point the SDK at", () => {
    expect(engineHealthUrl({ INNGEST_BASE_URL: "http://127.0.0.1:8288" })).toBe(
      "http://127.0.0.1:8288/health",
    );
  });

  it("asks a Dev Server named by URL, or the default one when INNGEST_DEV is a flag", () => {
    expect(engineHealthUrl({ INNGEST_DEV: "http://127.0.0.1:9999" })).toBe(
      "http://127.0.0.1:9999/health",
    );
    expect(engineHealthUrl({ INNGEST_DEV: "1" })).toBe("http://localhost:8288/health");
  });

  it("has nothing to ask for a hosted engine", () => {
    expect(engineHealthUrl({})).toBeNull();
    expect(engineHealthUrl({ INNGEST_DEV: "0" })).toBeNull();
  });
});

describe("probeEngine", () => {
  it("is ok when the engine answers 2xx", async () => {
    const health = await probeEngine("http://engine.test/health", async () => new Response("ok"));
    expect(health).toEqual({ state: "ok", detail: null });
  });

  it("is unreachable, with the status, when the engine answers an error", async () => {
    const health = await probeEngine(
      "http://engine.test/health",
      async () => new Response("", { status: 503 }),
    );
    expect(health).toEqual({ state: "unreachable", detail: "engine answered 503" });
  });

  it("is unreachable rather than throwing when nothing listens", async () => {
    const health = await probeEngine("http://engine.test/health", async () => {
      throw new TypeError("fetch failed");
    });
    expect(health.state).toBe("unreachable");
    expect(health.detail).toContain("refused");
  });

  it("gives up on an engine that never answers", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const health = await probeEngine("http://engine.test/health", hang, 20);
    expect(health).toEqual({ state: "unreachable", detail: "engine did not answer within 0.02s" });
  });

  it("says unknown, not down, when there is no address to ask", async () => {
    expect((await probeEngine(null)).state).toBe("unknown");
  });
});

describe("GET /health", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  it("answers the report the web app parses, uncached", async () => {
    const res = await handleHealthGet(async () => ({ state: "unreachable", detail: "down" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(orchestratorHealthReport.parse(await res.json())).toEqual({
      status: "ok",
      service: "orchestrator",
      engine: { state: "unreachable", detail: "down" },
    });
  });

  it("probes a real engine over HTTP", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/health"
          ? new Response("ok")
          : new Response("", { status: 404 }),
    });
    const url = engineHealthUrl({ INNGEST_BASE_URL: `http://127.0.0.1:${server.port}` });
    const res = await handleHealthGet(() => probeEngine(url));
    expect(orchestratorHealthReport.parse(await res.json()).engine.state).toBe("ok");
  });
});
