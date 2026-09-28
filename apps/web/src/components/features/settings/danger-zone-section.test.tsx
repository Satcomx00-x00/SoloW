/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { DangerZoneSection } from "./danger-zone-section";

/**
 * The reset gate (spec F16).
 *
 * The assertions are about the *gate*, not the delete — the walk itself is covered in
 * `@solow/db` and the router contract in `workspace.reset.test.ts`. What only this test can see
 * is that the destructive button cannot be reached without typing the name, which is the single
 * thing standing between a stray click and a workspace with no data in it.
 */

afterEach(cleanup);

const HANDLERS = {
  "workspace.get": () => ({ id: "ws-1", name: "acme", createdAt: "2026-01-01T00:00:00.000Z" }),
  "workspace.reset": () => ({
    scope: "work-data",
    removed: [{ table: "task", rows: 3 }],
    rows: 3,
    worktrees: ["/worktrees/task-1"],
  }),
};

/**
 * Press one of the two triggers and hand back the dialog it opened.
 *
 * Queries inside are scoped to that element on purpose: the dialog's submit button carries the
 * same label as the trigger that opened it — deliberately, so the sentence you pressed is the
 * sentence you confirm — which makes an unscoped `getByRole` ambiguous.
 */
async function openDialog(button: string) {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return within(await screen.findByRole("dialog"));
}

describe("the reset section", () => {
  it("offers both scopes, and says what each one keeps", async () => {
    renderWithTrpc(<DangerZoneSection />, HANDLERS);

    expect(await screen.findByRole("button", { name: "Reset work data" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Erase everything" })).toBeDefined();
    // What survives matters more than what goes: it is the difference between the two.
    expect(screen.getByText(/Keeps your repositories/)).toBeDefined();
    expect(screen.getByText(/Keeps your account/)).toBeDefined();
  });

  it("keeps the destructive button disabled until the name is typed exactly", async () => {
    renderWithTrpc(<DangerZoneSection />, HANDLERS);
    const dialog = await openDialog("Reset work data");

    const confirm = dialog.getByRole("button", { name: "Reset work data" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    // Close, but not equal — a prefix must not arm it.
    fireEvent.change(dialog.getByLabelText("Type acme to confirm"), {
      target: { value: "acm" },
    });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(dialog.getByLabelText("Type acme to confirm"), { target: { value: "acme" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
  });

  it("sends the scope of the button that was pressed", async () => {
    const { log } = renderWithTrpc(<DangerZoneSection />, HANDLERS);
    const dialog = await openDialog("Erase everything");

    fireEvent.change(dialog.getByLabelText("Type acme to confirm"), {
      target: { value: "acme" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Erase everything" }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "workspace.reset");
      // The two buttons are one dialog; sending the wrong scope would quietly erase the setup
      // for someone who asked only for the work.
      expect(writes.at(-1)?.input).toEqual({ scope: "everything", confirmName: "acme" });
    });
  });

  it("reports what was removed, because nothing else will", async () => {
    renderWithTrpc(<DangerZoneSection />, HANDLERS);
    const dialog = await openDialog("Reset work data");

    fireEvent.change(dialog.getByLabelText("Type acme to confirm"), {
      target: { value: "acme" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Reset work data" }));

    expect(await screen.findByText(/Removed 3 rows across 1 table/)).toBeDefined();
  });

  it("forgets the typed name when cancelled, so the next opening starts disarmed", async () => {
    renderWithTrpc(<DangerZoneSection />, HANDLERS);
    let dialog = await openDialog("Reset work data");
    fireEvent.change(dialog.getByLabelText("Type acme to confirm"), { target: { value: "acme" } });

    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Reopened from the *other* button: an armed field carried across would turn "I changed my
    // mind about the work" into one click from erasing the setup as well.
    dialog = await openDialog("Erase everything");

    expect((dialog.getByLabelText("Type acme to confirm") as HTMLInputElement).value).toBe("");
    expect(
      (dialog.getByRole("button", { name: "Erase everything" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the server's refusal and stays open, rather than looking as if it worked", async () => {
    renderWithTrpc(<DangerZoneSection />, {
      ...HANDLERS,
      "workspace.reset": () => {
        throw new Error("Too many resets — try again in an hour");
      },
    });
    const dialog = await openDialog("Reset work data");
    fireEvent.change(dialog.getByLabelText("Type acme to confirm"), { target: { value: "acme" } });

    fireEvent.click(dialog.getByRole("button", { name: "Reset work data" }));

    expect((await dialog.findByRole("alert")).textContent).toContain("Too many resets");
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.queryByText(/Removed \d+ rows/)).toBeNull();
  });

  it("cannot be opened before the Workspace's name is known", async () => {
    // With no name to type back, the gate would compare against an empty string.
    renderWithTrpc(<DangerZoneSection />, {
      ...HANDLERS,
      "workspace.get": () => new Promise(() => {}),
    });

    const trigger = (await screen.findByRole("button", {
      name: "Reset work data",
    })) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});
