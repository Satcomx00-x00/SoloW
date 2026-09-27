/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { TaskDefaultsSection } from "./task-defaults-section";

/**
 * Choosing what a new Task starts as (spec F16).
 *
 * The form side of the feature is pinned in `create-task-dialog.test.tsx`; what these cover is
 * the writing of it — including clearing one, which is the case a picker built on a Select gets
 * wrong by default, because `""` is not a value a Radix item may carry.
 */

afterEach(cleanup);

const PROFILES = {
  "profile.agent.list": () => ({
    items: [
      { id: "harness-1", name: "Claude" },
      { id: "harness-2", name: "opencode" },
    ],
    nextCursor: null,
  }),
  "profile.executor.list": () => ({ items: [{ id: "exec-1", name: "Local" }], nextCursor: null }),
};

const CHOSEN = {
  ...PROFILES,
  "preference.getTaskDefaults": () => ({
    workspaceId: "ws-1",
    userId: "ada",
    defaults: { harnessProfileId: "harness-1", executorProfileId: "exec-1" },
  }),
  "preference.setTaskDefaults": (input: unknown) => ({
    workspaceId: "ws-1",
    userId: "ada",
    defaults: input,
  }),
};

const NOTHING_CHOSEN = {
  ...CHOSEN,
  "preference.getTaskDefaults": () => ({
    workspaceId: "ws-1",
    userId: "ada",
    defaults: { harnessProfileId: null, executorProfileId: null },
  }),
};

async function pick(label: string, option: string): Promise<void> {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("the new-task defaults section", () => {
  it("shows what is currently chosen", async () => {
    renderWithTrpc(<TaskDefaultsSection />, CHOSEN);

    expect(
      (await screen.findByRole("combobox", { name: "Default harness profile" })).textContent,
    ).toContain("Claude");
    expect(screen.getByRole("combobox", { name: "Default executor" }).textContent).toContain(
      "Local",
    );
  });

  it("saves a change without disturbing the other half of the pair", async () => {
    const { log } = renderWithTrpc(<TaskDefaultsSection />, CHOSEN);
    await screen.findByRole("combobox", { name: "Default harness profile" });

    await pick("Default harness profile", "opencode");

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "preference.setTaskDefaults");
      // One input carries both fields, so writing one must carry the other through unchanged —
      // otherwise choosing a harness silently clears the executor.
      expect(writes.at(-1)?.input).toEqual({
        harnessProfileId: "harness-2",
        executorProfileId: "exec-1",
      });
    });
  });

  it("can clear a default back to asking every time", async () => {
    const { log } = renderWithTrpc(<TaskDefaultsSection />, CHOSEN);
    await screen.findByRole("combobox", { name: "Default executor" });

    await pick("Default executor", "Ask every time");

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "preference.setTaskDefaults");
      // Null, not the sentinel the Select needs internally — a Radix item cannot carry `""`, so
      // "nothing" has to be a value on the way in and a null on the way out.
      expect(writes.at(-1)?.input).toEqual({
        harnessProfileId: "harness-1",
        executorProfileId: null,
      });
    });
  });

  it("says nothing is chosen when nothing is", async () => {
    renderWithTrpc(<TaskDefaultsSection />, NOTHING_CHOSEN);

    expect(await screen.findByText("Nothing chosen")).toBeDefined();
  });
});
