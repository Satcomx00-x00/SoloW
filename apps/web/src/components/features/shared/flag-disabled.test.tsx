/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { FlagDisabled } from "./flag-disabled";

/**
 * What a surface says once its flag has been turned off (constitution v1.5.0).
 *
 * The screen an operator reaches by using the kill switch, which makes it the screen that has to
 * tell them how to undo it. Before the default flipped it said "Feature flags ship off" and gave
 * only a terminal command — a sentence that was about to become untrue, and a route out that the
 * person who pressed the switch in the browser could not take.
 *
 * So the assertions are about the way back being reachable *in the app*, which is the property
 * `flag.set` sitting on `sessionProcedure` exists to guarantee: the one screen that can reverse
 * a kill switch is never itself behind the switch.
 */

afterEach(cleanup);

describe("the flag-disabled notice", () => {
  it("links to the Settings section that can turn the flag back on", () => {
    render(<FlagDisabled flag="ff-workflows" title="Workflows are not enabled here" />);

    const link = screen.getByRole("link", { name: /Settings . Feature flags/ });
    // Deep-linked to the section, not to the top of Settings: a page that lands you somewhere
    // you then have to search is the reason the section ids exist.
    expect(link.getAttribute("href")).toBe("/settings?section=flags");
  });

  it("names the flag in the command, so the terminal route works for the right one", () => {
    render(<FlagDisabled flag="ff-agent-libraries" title="Harness libraries are off" />);

    expect(screen.getByText(/bun run flag enable ff-agent-libraries/)).toBeDefined();
  });

  it("says somebody turned it off, rather than that it ships off", () => {
    render(<FlagDisabled flag="ff-mcp" title="MCP is not enabled here" />);

    // The copy this replaced claimed flags ship off. They do not, and a reader who believed it
    // would go looking for a first-run step that does not exist instead of for the person who
    // used the switch.
    expect(screen.getByText(/turned this feature off/i)).toBeDefined();
    expect(screen.queryByText(/ships? off/i)).toBeNull();
  });

  it("announces itself, because it replaces the content the reader came for", () => {
    render(<FlagDisabled flag="ff-core-program" title="The core program is not enabled here" />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The core program is not enabled here");
  });
});
