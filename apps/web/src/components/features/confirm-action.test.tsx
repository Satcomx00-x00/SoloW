/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ConfirmAction, ConfirmDialog } from "./confirm-action";

/**
 * The shared confirmation gate (task TASK-022). Both destructive paths — rejecting a review and
 * dragging a Task out of Review — route through here, so this is where "no destructive action is
 * one click" is actually enforced.
 */

afterEach(cleanup);

const copy = {
  title: "Discard the work?",
  description: "This cannot be undone.",
  confirmLabel: "Discard it",
};

describe("ConfirmAction", () => {
  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [confirmed, setConfirmed] = useState(0);
    return (
      <div>
        <span data-testid="confirmed">{confirmed}</span>
        <ConfirmAction
          {...copy}
          disabled={disabled}
          onConfirm={() => setConfirmed((n) => n + 1)}
          trigger={
            <button type="button" disabled={disabled}>
              Reject
            </button>
          }
        />
      </div>
    );
  }

  it("asks before acting, and only acts once confirmed", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByTestId("confirmed").textContent).toBe("0");

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("This cannot be undone.");

    fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
    await waitFor(() => expect(screen.getByTestId("confirmed").textContent).toBe("1"));
  });

  it("cancelling does nothing at all", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("confirmed").textContent).toBe("0");
  });

  it("closes after confirming, so a second click is a fresh decision", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard it" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("a disabled trigger cannot open the confirmation", async () => {
    render(<Harness disabled />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  it("confirms an action raised by something other than a button (a drag)", async () => {
    let confirmed = 0;
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          {...copy}
          open={open}
          onOpenChange={setOpen}
          onConfirm={() => {
            confirmed += 1;
          }}
        />
      );
    }
    render(<Harness />);

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
    await waitFor(() => expect(confirmed).toBe(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
