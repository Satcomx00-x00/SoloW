/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { ImportIssuesDialog } from "./import-issues-dialog";

/**
 * The import picker's filters (user report: issue import was scattered and cramped).
 *
 * A linked repository routinely has more issues than fit on a screen, so the interesting
 * behaviour is not "the list renders" but what narrowing it does to the *selection* — the thing
 * the Import button then acts on. Select-all in particular has to mean "what I can see and can
 * actually import", or it produces a count the server would refuse.
 */

afterEach(cleanup);

const external = [
  {
    externalId: "e1",
    number: 12,
    title: "Fix the latch",
    description: null,
    state: "open",
    url: "u1",
    alreadyImported: false,
  },
  {
    externalId: "e2",
    number: 14,
    title: "Debounce keypad",
    description: null,
    state: "closed",
    url: "u2",
    alreadyImported: false,
  },
  {
    externalId: "e3",
    number: 19,
    title: "Sync branches",
    description: null,
    state: "open",
    url: "u3",
    alreadyImported: true,
  },
];

const handlers = {
  "repository.list": () => ({
    items: [{ id: "repo-1", name: "gate", integrationId: "int-1", externalFullName: "acme/gate" }],
    nextCursor: null,
  }),
  "integration.listExternalIssues": () => external,
};

/** The dialog opens itself when driven controlled, which is how `CreateMenu` uses it. */
function renderOpen(extra: Record<string, unknown> = {}) {
  return renderWithTrpc(<ImportIssuesDialog trigger={null} open onOpenChange={() => {}} />, {
    ...handlers,
    ...extra,
  });
}

describe("ImportIssuesDialog", () => {
  it("narrows the list by title, and by issue number", async () => {
    renderOpen();
    await screen.findByText(/Fix the latch/);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "debounce" } });
    await waitFor(() => expect(screen.queryByText(/Fix the latch/)).toBeNull());
    expect(screen.getByText(/Debounce keypad/)).toBeDefined();

    // The number is what a person actually remembers about an issue, so it searches too.
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "19" } });
    await waitFor(() => expect(screen.getByText(/Sync branches/)).toBeDefined());
    expect(screen.queryByText(/Debounce keypad/)).toBeNull();
  });

  it("selects only what is visible and importable, never the already-imported rows", async () => {
    renderOpen();
    await screen.findByText(/Fix the latch/);

    // Three issues, but #19 is already in SoloW — so two are selectable.
    fireEvent.click(screen.getByRole("button", { name: /Select all 2/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Import selected \(2\)/ })).toBeDefined(),
    );
  });

  it("keeps select-all honest once a filter is applied", async () => {
    renderOpen();
    await screen.findByText(/Fix the latch/);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "latch" } });
    // One row left, and it is importable — so the offer is for one, not for the whole repo.
    await waitFor(() => expect(screen.getByRole("button", { name: /Select all 1/ })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /Select all 1/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Import selected \(1\)/ })).toBeDefined(),
    );
  });

  it("sends exactly the checked ids to the repository they were chosen from", async () => {
    const sent: unknown[] = [];
    renderOpen({
      "integration.importIssues": (input: unknown) => {
        sent.push(input);
        return [];
      },
    });
    await screen.findByText(/Fix the latch/);

    fireEvent.click(screen.getByRole("checkbox", { name: "Import Fix the latch" }));
    fireEvent.click(screen.getByRole("button", { name: /Import selected \(1\)/ }));

    await waitFor(() => expect(sent).toEqual([{ repositoryId: "repo-1", externalIds: ["e1"] }]));
  });

  it("says so when the filters hide everything, rather than showing an empty box", async () => {
    renderOpen();
    await screen.findByText(/Fix the latch/);

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "nothing matches this" },
    });

    expect(await screen.findByText("No issues match these filters.")).toBeDefined();
  });
});
