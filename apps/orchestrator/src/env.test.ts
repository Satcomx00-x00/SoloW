import { describe, expect, it } from "bun:test";
import { z } from "zod";

// `orchestratorEnv()` caches the first parse for the life of the process, so the default is
// checked by running the schema's own field through a fresh parse in a child process.
describe("SOLOW_BIND_HOST", () => {
  const probe = async (env: Record<string, string>) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        'import("./src/env.ts").then((m) => console.log(m.orchestratorEnv().SOLOW_BIND_HOST))',
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: { PATH: process.env.PATH ?? "", SOLOW_STREAM_SECRET: "x", ...env },
        stdout: "pipe",
      },
    );
    return z.string().parse((await new Response(proc.stdout).text()).trim());
  };

  it("listens on this machine only unless told otherwise", async () => {
    expect(await probe({})).toBe("127.0.0.1");
  });

  it("takes an explicit interface", async () => {
    expect(await probe({ SOLOW_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("still boots when SOLOW_ORCHESTRATOR_SECRET is too short — only POST /events refuses", async () => {
    // A short secret used to throw out of `orchestratorEnv()`, the first thing the WebSocket
    // server reads, and took the hub, the terminal and every run down with the one route it
    // guards. `handleEventPost` answers 503 for it instead (events.test.ts).
    expect(await probe({ SOLOW_ORCHESTRATOR_SECRET: "short" })).toBe("127.0.0.1");
  });
});
