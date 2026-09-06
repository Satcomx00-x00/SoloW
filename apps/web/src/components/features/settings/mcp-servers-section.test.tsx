/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { McpServersSection } from "./mcp-servers-section";

const AT = "2026-08-20T00:00:00.000Z";

afterEach(cleanup);

describe("McpServersSection", () => {
  it("switches a server on for every agent through the row's checkbox", async () => {
    const { log } = renderWithTrpc(<McpServersSection />, {
      "library.mcp.list": () => [
        {
          id: "m1",
          name: "github",
          description: null,
          transport: { kind: "http", url: "https://x.example/mcp", headers: {} },
          enabled: false,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      "secret.list": () => [],
      "library.mcp.update": () => ({}),
    });

    fireEvent.click(await screen.findByLabelText("Load github in every agent"));
    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "library.mcp.update");
      expect(call?.input).toEqual({ id: "m1", enabled: true });
    });
  });

  it("splits the command line the way a shell would, and sends a secret by reference, never by value", async () => {
    const { log } = renderWithTrpc(<McpServersSection />, {
      "library.mcp.list": () => [],
      "secret.list": () => [
        { id: "s1", name: "gh-token", kind: "api_key", createdAt: AT, updatedAt: AT },
      ],
      "library.mcp.create": () => ({}),
    });

    fireEvent.click(await screen.findByRole("button", { name: "New MCP server" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "github" } });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: `npx -y @modelcontextprotocol/server-github --name "My GitHub"` },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Add MCP server" }).closest("form")!);

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "library.mcp.create");
      expect(call?.input).toEqual({
        name: "github",
        transport: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github", "--name", "My GitHub"],
          env: {},
        },
        enabled: false,
      });
    });
  });

  it("tells a workspace with the flag off how to enable it", async () => {
    renderWithTrpc(<McpServersSection />, {
      "library.mcp.list": () => {
        throw new Error("FLAG_DISABLED");
      },
      "secret.list": () => [],
    });
    expect(await screen.findByText(/bun run flag enable ff-agent-libraries/)).toBeTruthy();
  });
});
