/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { BacklogActions } from "./backlog-actions";

/**
 * The Backlog column's two header entry points (user report: creating an issue and adding a
 * repository should both be possible straight from the board's Backlog, not only from a
 * separate page or Settings).
 */

afterEach(cleanup);

describe("BacklogActions", () => {
  it("opens the new-issue dialog from its own button", async () => {
    renderWithTrpc(<BacklogActions />, { "repository.list": () => [] });
    fireEvent.click(screen.getByRole("button", { name: "New issue" }));
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(await screen.findByLabelText("Title")).toBeDefined();
  });

  it("opens the connect-repository dialog from its own, separate button", async () => {
    renderWithTrpc(<BacklogActions />, { "repository.list": () => [] });
    fireEvent.click(screen.getByRole("button", { name: "Connect a repository" }));
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(await screen.findByLabelText("Location")).toBeDefined();
  });
});
