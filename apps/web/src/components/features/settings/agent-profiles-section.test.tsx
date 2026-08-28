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
      "profile.agent.list": () => ({
        items: [
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
        nextCursor: null,
      }),
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
      "profile.agent.list": () => ({
        items: [
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
        nextCursor: null,
      }),
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
      "profile.agent.list": () => ({
        items: [
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
        nextCursor: null,
      }),
    });

    expect(
      await screen.findByText("Used by 1 task, 2 workflow steps, 5 past sessions"),
    ).toBeDefined();
  });

  it("offers deletion freely for a Profile nothing references", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => ({
        items: [
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
        nextCursor: null,
      }),
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
      "profile.agent.list": () => ({
        items: [
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
        nextCursor: null,
      }),
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
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
    });

    await screen.findByText("Add a custom agent");
    expect(screen.queryByLabelText("Command")).toBeNull();
  });

  it("declares a new catalog entry with the fields that matter for billing integrity", async () => {
    let sent: unknown = null;
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
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
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
    });

    fireEvent.click(await screen.findByText("Add a custom agent"));
    expect(await screen.findByText("claude_code")).toBeDefined();
    expect(screen.getByText(/Claude Code · claude_code_stream_json/)).toBeDefined();
  });

  it("surfaces a duplicate-key refusal instead of failing silently", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
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

/**
 * Pinning a model and a mode on a Profile (issue #94, AC-1).
 *
 * Both used to be unexpressible: every run took whatever the CLI defaulted to. The field is free
 * text rather than a dropdown on purpose — what an agent offers comes from its handshake, so
 * there is nothing to populate a menu with before a Profile has ever run, and a hardcoded list
 * would offer choices that fail at launch the first time a provider retires one.
 */
describe("model and mode on an Agent Profile", () => {
  /** The form refuses to submit without a Secret, so both cases have to pick one. */
  const chooseSecret = async () => {
    fireEvent.click(screen.getByRole("combobox", { name: /secret/i }));
    fireEvent.click(await screen.findByRole("option", { name: /anthropic-key/ }));
  };

  it("sends null for a pin left empty, so the agent keeps the choice", async () => {
    const { log } = renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
      "profile.agent.create": (input) => input,
    });

    await screen.findByLabelText("Model");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Plain" } });
    await chooseSecret();
    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));

    await waitFor(() =>
      expect(log.calls.some((c) => c.path === "profile.agent.create")).toBe(true),
    );
    const input = log.calls.find((c) => c.path === "profile.agent.create")?.input as {
      model: unknown;
      modeId: unknown;
    };
    // Null, not "": an empty pin is the absence of one, and a blank string would make "no model"
    // and "a model named nothing" the same row.
    expect(input.model).toBeNull();
    expect(input.modeId).toBeNull();
  });

  it("sends what was typed, trimmed", async () => {
    const { log } = renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
      "profile.agent.create": (input) => input,
    });

    await screen.findByLabelText("Model");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Opus planner" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "  claude-opus-4  " } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "plan" } });
    await chooseSecret();
    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));

    await waitFor(() =>
      expect(log.calls.some((c) => c.path === "profile.agent.create")).toBe(true),
    );
    expect(log.calls.find((c) => c.path === "profile.agent.create")?.input).toMatchObject({
      model: "claude-opus-4",
      modeId: "plan",
    });
  });
});

/**
 * The pin fields suggest what the agent advertised, and a pin it no longer advertises is said
 * (issue #94, AC-2 / AC-3).
 *
 * The suggestions come from `agent_catalog.capabilities` — a cache the orchestrator writes from
 * each run's handshake. Before a first run it is empty, which is why the fields are datalists
 * over free text rather than closed dropdowns: a menu would offer nothing at all on a fresh
 * install and claim the list is complete everywhere else.
 */
describe("advertised capabilities in the Profile form", () => {
  const CAPS = { models: ["claude-opus-4", "claude-sonnet-4"], modes: ["plan"] };
  const catalogWithCaps = () => [{ id: "cat-1", displayName: "Claude Code", capabilities: CAPS }];

  it("offers the cached models and modes as suggestions", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agentCatalog.list": catalogWithCaps,
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
    });

    await screen.findByLabelText("Model");
    // The datalist is the suggestion surface; its options are what the agent last advertised.
    const modelOptions = [...document.querySelectorAll("#agent-model-options option")].map(
      (o) => (o as HTMLOptionElement).value,
    );
    const modeOptions = [...document.querySelectorAll("#agent-mode-options option")].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(modelOptions).toEqual(["claude-opus-4", "claude-sonnet-4"]);
    expect(modeOptions).toEqual(["plan"]);
  });

  it("marks a Profile whose pin the agent no longer advertises", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agentCatalog.list": catalogWithCaps,
      "profile.agent.list": () => ({
        items: [
          {
            id: "p1",
            name: "Old pin",
            agentCatalogId: "cat-1",
            authMode: "api_key",
            secretId: "secret-1",
            concurrencyCap: 3,
            permissionMode: "bypassPermissions",
            model: "claude-opus-3",
            modeId: null,
            usage: NO_USAGE,
          },
        ],
        nextCursor: null,
      }),
    });

    // AC-3's surface: the run never substitutes silently, and this is where somebody fixes the
    // pin *before* the launch that would have to say so.
    expect(await screen.findByText(/claude-opus-3 no longer advertised/)).toBeDefined();
  });

  it("does not warn when the cache is empty — unknown is not retired", async () => {
    renderWithTrpc(<AgentProfilesSection />, {
      ...baseHandlers,
      "profile.agentCatalog.list": () => [
        { id: "cat-1", displayName: "Claude Code", capabilities: { models: [], modes: [] } },
      ],
      "profile.agent.list": () => ({
        items: [
          {
            id: "p1",
            name: "Pinned before any run",
            agentCatalogId: "cat-1",
            authMode: "api_key",
            secretId: "secret-1",
            concurrencyCap: 3,
            permissionMode: "bypassPermissions",
            model: "claude-opus-4",
            modeId: null,
            usage: NO_USAGE,
          },
        ],
        nextCursor: null,
      }),
    });

    await screen.findByText(/Pinned before any run/);
    expect(screen.queryByText(/no longer advertised/)).toBeNull();
  });
});

/**
 * Managing more than one agent (2026-08-28). A Workspace now ships with Claude Code and
 * opencode, and they differ on exactly the axis this form exposes: stream-JSON takes a model and
 * has no session mode, ACP has a mode and no way to select a model. The form has to refuse the
 * pin the chosen agent cannot be told — offering it would store a setting every run then reports
 * it could not honour, which is the silent substitution the rule exists to prevent.
 */
describe("AgentProfilesSection — two agents with different protocols", () => {
  const twoAgents = {
    ...baseHandlers,
    "profile.agentCatalog.list": () => [
      { id: "cat-1", displayName: "Claude Code", protocol: "claude_code_stream_json" },
      { id: "cat-2", displayName: "opencode", protocol: "acp" },
    ],
    "profile.agent.list": () => ({ items: [], nextCursor: null }),
  };

  /** No jest-dom here, so disabled is read off the DOM the way the rest of this suite does. */
  const isDisabled = (label: string) => screen.getByLabelText(label).hasAttribute("disabled");

  /** Radix drives its own events, so pick the way the rest of the suite does: open, then click. */
  const chooseAgent = async (displayName: string) => {
    fireEvent.click(await screen.findByRole("combobox", { name: "Agent" }));
    fireEvent.click(await screen.findByRole("option", { name: displayName }));
  };

  it("disables Mode for the stream-JSON agent, which has no notion of one", async () => {
    renderWithTrpc(<AgentProfilesSection />, twoAgents);

    // cat-1 is preselected, so this is what an Owner sees before touching anything.
    await waitFor(() => expect(isDisabled("Mode")).toBe(true));
    expect(isDisabled("Model")).toBe(false);
  });

  it("disables Model for the ACP agent, and says which protocol it is", async () => {
    renderWithTrpc(<AgentProfilesSection />, twoAgents);
    await waitFor(() => expect(isDisabled("Model")).toBe(false));

    await chooseAgent("opencode");

    await waitFor(() => expect(isDisabled("Model")).toBe(true));
    expect(isDisabled("Mode")).toBe(false);
    // The consequence of the choice, said where the choice is made. Scoped to this form: the
    // custom-agent form below carries the same hints for its own protocol picker.
    const form = screen.getByRole("button", { name: "Add profile" }).closest("form");
    expect(within(form as HTMLElement).getByText(/Agent Client Protocol/)).toBeDefined();
  });

  it("never submits a pin the chosen agent's protocol would ignore", async () => {
    // The trap this guards: type a model against Claude Code, switch to opencode, submit. The
    // field is disabled by then, but its value is still in state.
    const created: unknown[] = [];
    renderWithTrpc(<AgentProfilesSection />, {
      ...twoAgents,
      "profile.agent.create": (input) => {
        created.push(input);
        return { id: "p9", name: "n", agentCatalogId: "cat-2", usage: NO_USAGE };
      },
    });

    await waitFor(() => expect(isDisabled("Model")).toBe(false));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "opus" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "mine" } });
    // The form refuses to submit without a credential, so choose one before the pin matters.
    fireEvent.click(screen.getByRole("combobox", { name: "Secret" }));
    fireEvent.click(await screen.findByRole("option", { name: /anthropic-key/ }));

    await chooseAgent("opencode");
    await waitFor(() => expect(isDisabled("Model")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ agentCatalogId: "cat-2", model: null });
  });
});
