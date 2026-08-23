/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { AgentProfilesSection } from "./agent-profiles-section";

/**
 * Agent Profile deletion from Settings. `agent_profile.id` is a real foreign key on Tasks,
 * Workflow Steps, and Session usage, so the interesting cases here are the same shape as
 * `secrets-section.test.tsx`'s: the refusal is disabled and explained before the click, not only
 * discovered after it.
 */

afterEach(cleanup);

const NO_USAGE = { taskCount: 0, workflowStepCount: 0, sessionUsageCount: 0 };

const baseHandlers = {
  "profile.agentCatalog.list": () => [{ id: "cat-1", displayName: "Claude Code" }],
  "secret.list": () => [{ id: "secret-1", name: "anthropic-key", kind: "api_key", usedBy: [] }],
};

describe("AgentProfilesSection", () => {
  it("deletes a Profile only after the Owner confirms it", async () => {
    const deleted: unknown[] = [];
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [
        {
          id: "p1",
          name: "Claude Code (subscription)",
          agentCatalogId: "cat-1",
          authMode: "subscription",
          secretId: "secret-1",
          concurrencyCap: 3,
          usage: NO_USAGE,
        },
      ],
      "profile.agent.delete": (input) => {
        deleted.push(input);
        return {
          id: "p1",
          name: "Claude Code (subscription)",
          agentCatalogId: "cat-1",
          authMode: "subscription",
          secretId: "secret-1",
          concurrencyCap: 3,
          usage: NO_USAGE,
        };
      },
    });

    const trigger = await screen.findByRole("button", {
      name: "Delete the agent profile Claude Code (subscription)",
    });
    fireEvent.click(trigger);

    // Opening the confirmation must not be the delete: same reasoning as Secrets — a stored
    // Profile cannot be un-deleted, so a stray click on a ghost icon button must not be it.
    expect(deleted).toHaveLength(0);

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));

    await waitFor(() => expect(deleted).toEqual([{ id: "p1" }]));
  });

  it("refuses to offer deletion for a Profile a Task still holds, and says what holds it", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [
        {
          id: "p1",
          name: "Busy profile",
          agentCatalogId: "cat-1",
          authMode: "api_key",
          secretId: "secret-1",
          concurrencyCap: 3,
          usage: { taskCount: 3, workflowStepCount: 0, sessionUsageCount: 0 },
        },
      ],
    });

    const trigger = await screen.findByRole("button", {
      name: "Delete the agent profile Busy profile",
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    // The disabled button is only fair if the row says why — named, not just counted.
    expect(screen.getByText("Used by 3 tasks")).toBeDefined();
  });

  it("names every kind of holder together, singular where the count is one", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [
        {
          id: "p1",
          name: "Fully wired profile",
          agentCatalogId: "cat-1",
          authMode: "api_key",
          secretId: "secret-1",
          concurrencyCap: 3,
          usage: { taskCount: 1, workflowStepCount: 2, sessionUsageCount: 5 },
        },
      ],
    });

    expect(
      await screen.findByText("Used by 1 task, 2 workflow steps, 5 past sessions"),
    ).toBeDefined();
  });

  it("offers deletion freely for a Profile nothing references", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [
        {
          id: "p1",
          name: "Unused profile",
          agentCatalogId: "cat-1",
          authMode: "api_key",
          secretId: "secret-1",
          concurrencyCap: 3,
          usage: NO_USAGE,
        },
      ],
    });

    const trigger = await screen.findByRole("button", {
      name: "Delete the agent profile Unused profile",
    });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/Used by/)).toBeNull();
  });

  it("surfaces a delete failure to the Owner instead of failing silently", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [
        {
          id: "p1",
          name: "Raced profile",
          agentCatalogId: "cat-1",
          authMode: "api_key",
          secretId: "secret-1",
          concurrencyCap: 3,
          usage: NO_USAGE,
        },
      ],
      "profile.agent.delete": () => {
        throw new Error("AGENT_PROFILE_IN_USE");
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete the agent profile Raced profile" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("AGENT_PROFILE_IN_USE");
    });
  });
});

/**
 * Extending the agent catalog (spec F05 AC-1, issue #10/#58). The seeded `claude_code` row
 * (protocol `claude_code_stream_json`) has no permission channel; `acp` does — this is the form
 * that lets an Owner name an agent on that protocol at all, since until it existed no Agent
 * Profile could ever be pointed at one.
 */
describe("AgentProfilesSection — agent catalog", () => {
  it("is collapsed by default — most Owners never need it", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [],
    });

    await screen.findByText("Add a custom agent");
    expect(screen.queryByLabelText("Command")).toBeNull();
  });

  it("declares a new catalog entry with the fields that matter for billing integrity", async () => {
    let sent: unknown = null;
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [],
      "profile.agentCatalog.create": (input) => {
        sent = input;
        return { id: "cat-2", ...(input as object) };
      },
    });

    fireEvent.click(await screen.findByText("Add a custom agent"));
    fireEvent.change(await screen.findByLabelText("Key"), { target: { value: "claude_acp" } });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Claude Code (ACP)" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "claude-agent-acp" },
    });
    fireEvent.change(screen.getByLabelText("Subscription credential variable"), {
      target: { value: "CLAUDE_CODE_OAUTH_TOKEN" },
    });
    fireEvent.change(screen.getByLabelText("Metered credential variable"), {
      target: { value: "ANTHROPIC_API_KEY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to catalog" }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({
      key: "claude_acp",
      displayName: "Claude Code (ACP)",
      // Defaulted rather than exposed as a field — the form is for the two things billing
      // integrity actually depends on, not every column the table happens to have.
      protocol: "acp",
      command: "claude-agent-acp",
      argsTemplate: [],
      installHint: null,
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
  });

  it("lists what is already in the catalog, so a key collision is visible before it is attempted", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      "profile.agentCatalog.list": () => [
        {
          id: "cat-1",
          key: "claude_code",
          displayName: "Claude Code",
          protocol: "claude_code_stream_json",
        },
      ],
      "secret.list": () => [],
      "profile.agent.list": () => [],
    });

    fireEvent.click(await screen.findByText("Add a custom agent"));
    expect(await screen.findByText("claude_code")).toBeDefined();
    expect(screen.getByText(/Claude Code · claude_code_stream_json/)).toBeDefined();
  });

  it("surfaces a duplicate-key refusal instead of failing silently", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => [],
      "profile.agentCatalog.create": () => {
        throw new Error("AGENT_CATALOG_KEY_TAKEN");
      },
    });

    fireEvent.click(await screen.findByText("Add a custom agent"));
    fireEvent.change(await screen.findByLabelText("Key"), { target: { value: "claude_code" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Dup" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Subscription credential variable"), {
      target: { value: "TOKEN" },
    });
    fireEvent.change(screen.getByLabelText("Metered credential variable"), {
      target: { value: "KEY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to catalog" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("AGENT_CATALOG_KEY_TAKEN");
    });
  });
});
