/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { McpServersSection } from "./mcp-servers-section";

const AT = "2026-08-20T00:00:00.000Z";

afterEach(cleanup);

describe("McpStoreDialog", () => {
  it("installs a store entry with its credential as a Secret reference, and marks what is already there", async () => {
    const { log } = renderWithTrpc(<McpServersSection />, {
      "library.mcp.list": () => [
        {
          id: "m1",
          name: "github",
          description: null,
          transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/", headers: {} },
          enabled: false,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      "secret.list": () => [
        { id: "s1", name: "gitlab-pat", kind: "scm_pat", createdAt: AT, updatedAt: AT, usedBy: [] },
      ],
      "library.mcp.create": () => ({
        id: "m2",
        name: "gitlab",
        description: "x",
        transport: { kind: "stdio", command: "npx", args: [], env: {} },
        enabled: false,
        createdAt: AT,
        updatedAt: AT,
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Store" }));
    // What the library already holds is not offered twice.
    expect((await screen.findAllByText("Installed")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Search the store"), { target: { value: "gitlab" } });
    fireEvent.click(screen.getByRole("button", { name: "Install GitLab" }));
    // A credential is required: the install waits until a Secret is picked.
    fireEvent.click(screen.getByRole("button", { name: "Install GitLab" }));
    expect(await screen.findByText("Pick a Secret for this.")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "GitLab personal access token" }));
    fireEvent.click(await screen.findByRole("option", { name: "gitlab-pat" }));
    fireEvent.click(screen.getByRole("button", { name: "Install GitLab" }));

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "library.mcp.create");
      expect(call?.input).toEqual({
        name: "gitlab",
        description:
          "Projects, issues, merge requests, pipelines and files on gitlab.com or a self-hosted GitLab.",
        transport: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@zereight/mcp-gitlab"],
          env: {
            GITLAB_PERSONAL_ACCESS_TOKEN: { kind: "secret", secretId: "s1" },
            GITLAB_API_URL: { kind: "literal", value: "https://gitlab.com/api/v4" },
          },
        },
        enabled: false,
      });
    });
    // The line lands on the card behind the dialog, which Radix marks aria-hidden while it is open.
    expect((await screen.findByRole("status", { hidden: true })).textContent).toContain(
      "Installed gitlab",
    );
  });

  it("installs a local entry in one click, with nothing to fill in", async () => {
    const { log } = renderWithTrpc(<McpServersSection />, {
      "library.mcp.list": () => [],
      "secret.list": () => [],
      "library.mcp.create": () => ({
        id: "m3",
        name: "memory",
        description: "x",
        transport: { kind: "stdio", command: "npx", args: [], env: {} },
        enabled: false,
        createdAt: AT,
        updatedAt: AT,
      }),
    });
    fireEvent.click((await screen.findAllByRole("button", { name: /store/i }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Install Memory" }));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "library.mcp.create")?.input).toEqual({
        name: "memory",
        description:
          "A knowledge-graph memory the harness reads and writes across runs, kept in a local file.",
        transport: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
          env: {},
        },
        enabled: false,
      });
    });
  });
});
