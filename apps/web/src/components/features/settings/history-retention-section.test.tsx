/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { HistoryRetentionSection } from "./history-retention-section";

/**
 * Choosing how long a finished Task keeps its transcript (Decision 0032).
 *
 * The section's promise is that the Owner sees what a window removes *before* it is saved, so the
 * cases here are about that order: the preview follows the draft, Save is the only write, and
 * "Forever" is a null on the wire rather than a number the picker happened to hold.
 */

afterEach(cleanup);

function server(days: number | null) {
  return {
    "workspace.historyRetention": () => ({ days, defaultDays: 30, options: [7, 30, 90, 365] }),
    "workspace.previewHistoryRetention": (input: unknown) => {
      const asked = (input as { days: number }).days;
      return asked === 7
        ? { tasks: 4, sessions: 6, events: 12_345, diffs: 3, bytes: 5 * 1024 * 1024 }
        : { tasks: 0, sessions: 0, events: 0, diffs: 0, bytes: 0 };
    },
    "workspace.setHistoryRetention": (input: unknown) => ({
      days: (input as { days: number | null }).days,
      defaultDays: 30,
      options: [7, 30, 90, 365],
    }),
  };
}

async function pick(option: string): Promise<void> {
  fireEvent.click(await screen.findByRole("combobox", { name: "Keep transcripts for" }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("the history retention section", () => {
  it("shows the stored window, and says what it removes today", async () => {
    renderWithTrpc(<HistoryRetentionSection />, server(30));

    expect(
      (await screen.findByRole("combobox", { name: "Keep transcripts for" })).textContent,
    ).toContain("30 days");
    expect(await screen.findByText("Kept 30 days")).toBeDefined();
    expect(await screen.findByText(/nothing would be removed today/)).toBeDefined();
    // What is kept is said as plainly as what goes.
    expect(screen.getByText("Always kept")).toBeDefined();
  });

  it("counts a shorter window before anything is saved", async () => {
    const { log } = renderWithTrpc(<HistoryRetentionSection />, server(30));
    await screen.findByText(/nothing would be removed today/);

    await pick("7 days");

    const preview = await screen.findByText(/Saving this would remove/);
    expect(preview.textContent).toContain("12,345 transcript events");
    expect(preview.textContent).toContain("6 sessions of 4 finished tasks");
    expect(preview.textContent).toContain("3 diff patches");
    expect(preview.textContent).toContain("5.0 MB");
    expect(log.calls.some((c) => c.path === "workspace.setHistoryRetention")).toBe(false);
  });

  it("writes the window only on Save", async () => {
    const { log } = renderWithTrpc(<HistoryRetentionSection />, server(30));
    await screen.findByRole("combobox", { name: "Keep transcripts for" });

    await pick("90 days");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "workspace.setHistoryRetention");
      expect(writes.map((c) => c.input)).toEqual([{ days: 90 }]);
    });
    expect(await screen.findByText("Kept 90 days")).toBeDefined();
  });

  it("keeps forever as a null, and asks the server nothing about it", async () => {
    const { log } = renderWithTrpc(<HistoryRetentionSection />, server(30));
    await screen.findByRole("combobox", { name: "Keep transcripts for" });
    const previewsBefore = log.calls.filter(
      (c) => c.path === "workspace.previewHistoryRetention",
    ).length;

    await pick("Forever");
    expect(await screen.findByText(/Nothing is removed/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "workspace.setHistoryRetention");
      expect(writes.map((c) => c.input)).toEqual([{ days: null }]);
    });
    expect(await screen.findByText("Kept forever")).toBeDefined();
    expect(log.calls.filter((c) => c.path === "workspace.previewHistoryRetention")).toHaveLength(
      previewsBefore,
    );
  });

  it("opens on Forever for a Workspace that keeps everything", async () => {
    renderWithTrpc(<HistoryRetentionSection />, server(null));

    expect(
      (await screen.findByRole("combobox", { name: "Keep transcripts for" })).textContent,
    ).toContain("Forever");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });
});
