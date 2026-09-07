import { describe, expect, it } from "bun:test";
import { mcpServerTransportSchema } from "@solow/contracts";
import { MCP_STORE, MCP_STORE_CATEGORIES, mcpStoreEntry, mcpStoreTransport } from "./mcp-store.js";

describe("the MCP store", () => {
  it("has at least twenty well-known servers, GitHub and GitLab among them, each in a real category", () => {
    expect(MCP_STORE.length).toBeGreaterThanOrEqual(20);
    expect(mcpStoreEntry("github")?.transport.kind).toBe("http");
    expect(mcpStoreEntry("gitlab")?.transport.kind).toBe("stdio");
    const categories = new Set(MCP_STORE_CATEGORIES.map((c) => c.id));
    for (const entry of MCP_STORE) expect(categories.has(entry.category)).toBe(true);
  });

  it("never reuses an id or a library name, and names every credential as a Secret", () => {
    expect(new Set(MCP_STORE.map((e) => e.id)).size).toBe(MCP_STORE.length);
    expect(new Set(MCP_STORE.map((e) => e.name)).size).toBe(MCP_STORE.length);
    for (const entry of MCP_STORE) {
      expect(entry.name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(entry.homepage).toMatch(/^https:\/\//);
      for (const input of entry.transport.inputs) {
        if (/token|key|secret|password|uri|authorization/i.test(input.name))
          expect(input.secret).toBe(true);
      }
      // A "local" entry is one a fresh install can start: nothing required from the operator.
      if (entry.local) expect(entry.transport.inputs.every((i) => !i.required)).toBe(true);
    }
  });

  it("writes an installable transport: credentials by reference with their prefix, settings by value or default", () => {
    const github = mcpStoreEntry("github");
    const gitlab = mcpStoreEntry("gitlab");
    if (!github || !gitlab) throw new Error("fixture");

    expect(mcpStoreTransport(github, { secrets: {}, settings: {} })).toEqual({
      ok: false,
      missing: ["Authorization"],
    });
    const remote = mcpStoreTransport(github, { secrets: { Authorization: "sec-1" }, settings: {} });
    expect(remote).toEqual({
      ok: true,
      transport: {
        kind: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: { kind: "secret", secretId: "sec-1", prefix: "Bearer " } },
      },
    });

    const local = mcpStoreTransport(gitlab, {
      secrets: { GITLAB_PERSONAL_ACCESS_TOKEN: "sec-2" },
      settings: { GITLAB_API_URL: "  " },
    });
    expect(local).toEqual({
      ok: true,
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "@zereight/mcp-gitlab"],
        env: {
          GITLAB_PERSONAL_ACCESS_TOKEN: { kind: "secret", secretId: "sec-2" },
          GITLAB_API_URL: { kind: "literal", value: "https://gitlab.com/api/v4" },
        },
      },
    });
  });

  it("produces a transport the library's own schema accepts, for every entry with nothing filled in beyond what it requires", () => {
    for (const entry of MCP_STORE) {
      const secrets: Record<string, string> = {};
      for (const input of entry.transport.inputs)
        if (input.secret && input.required) secrets[input.name] = "sec";
      const out = mcpStoreTransport(entry, { secrets, settings: {} });
      if (!out.ok) throw new Error(`${entry.id}: missing ${out.missing.join(", ")}`);
      expect(mcpServerTransportSchema.safeParse(out.transport).success).toBe(true);
    }
  });
});
