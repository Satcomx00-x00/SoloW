/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { openCreateDialog } from "@/components/features/board/create-dialog-bus";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateMenu } from "./create-menu";

/**
 * The shell's single create/import surface (user report: those buttons were spread across the
 * board header, the Issues page header, the Backlog column and Settings).
 *
 * What matters here is that the menu is the *only* thing a caller needs: every one of the four
 * dialogs opens from it, from the bus the command palette uses, and — for the two it advertises
 * — from the keyboard, on whatever route the shell happens to be showing.
 */

afterEach(cleanup);

const handlers = {
  "issue.list": () => [],
  "repository.list": () => [],
  "secret.list": () => [],
  "profile.agent.list": () => [],
  "profile.executor.list": () => [],
};

/**
 * Open the menu itself — everything else in the component hangs off this.
 *
 * `pointerDown`, not `click`: Radix's menu trigger toggles on pointerdown, so a plain click
 * leaves the menu shut and every assertion after it fails for the wrong reason.
 */
async function openMenu() {
  const trigger = await screen.findByRole("button", { name: /Create/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

describe("CreateMenu", () => {
  it("offers all four ways to create or import, in one menu", async () => {
    renderWithTrpc(<CreateMenu />, handlers);
    const menu = await openMenu();

    for (const name of ["New task", "New issue", "Import issues…", "Connect a repository…"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(name) })).toBeDefined();
    }
    expect(menu).toBeDefined();
  });

  it("advertises the shortcuts it actually binds, so the menu is not lying about them", async () => {
    renderWithTrpc(<CreateMenu />, handlers);
    await openMenu();

    expect(screen.getByRole("menuitem", { name: /New task/ }).textContent).toContain("⌘⇧T");
    expect(screen.getByRole("menuitem", { name: /New issue/ }).textContent).toContain("⌘⇧I");
  });

  it("opens the New task dialog from the menu", async () => {
    renderWithTrpc(<CreateMenu />, handlers);
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /New task/ }));

    expect((await screen.findByRole("dialog")).textContent).toContain("New task");
  });

  it("opens the Import issues dialog from the menu", async () => {
    renderWithTrpc(<CreateMenu />, handlers);
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /Import issues/ }));

    expect((await screen.findByRole("dialog")).textContent).toContain("Import issues");
  });

  it("opens a dialog when something else asks over the bus — the command palette's path", async () => {
    renderWithTrpc(<CreateMenu />, handlers);
    // Waiting for the trigger first proves the subscription is mounted before the event fires.
    await screen.findByRole("button", { name: /Create/ });

    openCreateDialog("connect-repository");

    expect((await screen.findByRole("dialog")).textContent).toContain("Connect a repository");
  });

  it("opens New task on the keyboard shortcut, with no menu in the way", async () => {
    renderWithTrpc(<CreateMenu />, handlers);
    await screen.findByRole("button", { name: /Create/ });

    fireEvent.keyDown(document, { key: "T", ctrlKey: true, shiftKey: true });

    expect((await screen.findByRole("dialog")).textContent).toContain("New task");
  });

  it("leaves the shortcut alone while the caret is in a text field", async () => {
    renderWithTrpc(
      <>
        <input aria-label="Somewhere to type" />
        <CreateMenu />
      </>,
      handlers,
    );
    const input = await screen.findByLabelText("Somewhere to type");

    // ⇧ plus a letter is something a person types; stealing it here would eat their keystroke.
    fireEvent.keyDown(input, { key: "T", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
