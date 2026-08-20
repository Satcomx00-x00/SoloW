/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { FlagsSection } from "./flags-section";

/**
 * Settings toggle for feature flags (issue #21). The interesting case is `ff-core-program`'s
 * lockout: it is the one flag that, turned off, can strand the caller outside the page they are
 * standing on, so its OFF-toggle has to go through a confirmation while every other flag does
 * not.
 */

afterEach(cleanup);

const FLAGS = [
  {
    key: "ff-core-program",
    description: "Core end-to-end Task loop (Issue → run agent → review → approve).",
    default: false,
    enabled: false,
  },
  {
    key: "ff-workflows",
    description: "Agentic workflows — multi-step pipelines with a different agent per Step.",
    default: false,
    enabled: false,
  },
];

describe("FlagsSection", () => {
  it("renders each flag's key, description and current value from flag.list", async () => {
    renderWithTrpc(<FlagsSection />, { "flag.list": () => FLAGS });

    expect(await screen.findByText("ff-core-program")).toBeDefined();
    expect(
      screen.getByText("Core end-to-end Task loop (Issue → run agent → review → approve)."),
    ).toBeDefined();
    expect(screen.getByText("ff-workflows")).toBeDefined();
    const checkbox = screen.getByRole("checkbox", { name: "ff-core-program" });
    expect(checkbox.getAttribute("data-state")).toBe("unchecked");
  });

  it("reflects a flag already turned on", async () => {
    renderWithTrpc(<FlagsSection />, {
      "flag.list": () => FLAGS.map((f) => (f.key === "ff-workflows" ? { ...f, enabled: true } : f)),
    });

    const checkbox = await screen.findByRole("checkbox", { name: "ff-workflows" });
    expect(checkbox.getAttribute("data-state")).toBe("checked");
  });

  it("turning a non-core flag on calls flag.set directly, with no confirmation", async () => {
    const { log } = renderWithTrpc(<FlagsSection />, {
      "flag.list": () => FLAGS,
      "flag.set": (input) => ({ ...FLAGS[1], ...(input as object) }),
    });

    fireEvent.click(await screen.findByRole("checkbox", { name: "ff-workflows" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "flag.set");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.input).toEqual({ key: "ff-workflows", enabled: true });
    });
  });

  it("turning ff-core-program off opens a confirmation and does not call flag.set until confirmed", async () => {
    const { log } = renderWithTrpc(<FlagsSection />, {
      "flag.list": () =>
        FLAGS.map((f) => (f.key === "ff-core-program" ? { ...f, enabled: true } : f)),
      "flag.set": (input) => ({ ...FLAGS[0], ...(input as object) }),
    });

    fireEvent.click(await screen.findByRole("checkbox", { name: "ff-core-program" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Turn off the core Task loop?");
    expect(log.calls.filter((c) => c.path === "flag.set")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "flag.set");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.input).toEqual({ key: "ff-core-program", enabled: false });
    });
  });

  it("cancelling the confirmation leaves the flag on and never calls flag.set", async () => {
    const { log } = renderWithTrpc(<FlagsSection />, {
      "flag.list": () =>
        FLAGS.map((f) => (f.key === "ff-core-program" ? { ...f, enabled: true } : f)),
      "flag.set": (input) => ({ ...FLAGS[0], ...(input as object) }),
    });

    fireEvent.click(await screen.findByRole("checkbox", { name: "ff-core-program" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(log.calls.filter((c) => c.path === "flag.set")).toHaveLength(0);
    expect(
      screen.getByRole("checkbox", { name: "ff-core-program" }).getAttribute("data-state"),
    ).toBe("checked");
  });
});
