/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PermissionCard } from "./permission-card";
import type { PermissionRow } from "./transcript";

/**
 * The inline half of AC-4. The properties under test are the ones a reviewer relies on months
 * later: a live question offers exactly the agent's options, and a settled one is a record —
 * naming what was asked, what was answered and whether a human was the one who answered it.
 */

afterEach(cleanup);

function row(over: Partial<PermissionRow> = {}): PermissionRow {
  return {
    kind: "permission",
    id: "sess-1:3",
    sessionId: "sess-1",
    seq: 3,
    requestId: "req-1",
    title: "Write .env in the worktree",
    toolKind: "edit",
    toolCallId: "call-1",
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
    resolution: null,
    ...over,
  };
}

describe("PermissionCard", () => {
  it("shows what is being asked", () => {
    render(<PermissionCard row={row()} onRespond={() => {}} />);
    expect(screen.getByText("Write .env in the worktree")).toBeDefined();
  });

  it("reports the option the operator clicked, by the agent's own id", () => {
    const chosen: string[] = [];
    render(<PermissionCard row={row()} onRespond={(optionId) => chosen.push(optionId)} />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(chosen).toEqual(["no"]);
  });

  it("offers one button per option the agent offered, in its order, and no others", () => {
    // Ordering is the agent's: the option it lists first is the ordinary answer, and DOM order
    // is the tab order, so reordering here would change what a keyboard user reaches first.
    render(<PermissionCard row={row()} onRespond={() => {}} />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Allow once", "Reject"]);
    expect(screen.queryByRole("button", { name: /always/i })).toBeNull();
    // No dismiss: waving the card away would leave the operator believing they had declined.
    expect(screen.queryByRole("button", { name: /dismiss|cancel/i })).toBeNull();
  });

  it("names the question it belongs to, for a reader who arrives at it out of context", () => {
    render(<PermissionCard row={row()} onRespond={() => {}} />);
    expect(screen.getByRole("group", { name: /Write \.env in the worktree/ })).toBeDefined();
  });

  it("says plainly when the agent offered nothing to choose from", () => {
    render(<PermissionCard row={row({ options: [] })} onRespond={() => {}} />);
    expect(screen.getByText(/offered no options/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never offers a button for a question that is already settled", () => {
    // The one that matters on a reconnect: the log replays request *and* resolution, and a card
    // that stayed live would let an operator answer something answered minutes ago.
    render(
      <PermissionCard
        row={row({ resolution: { optionId: "once", decidedBy: "operator" } })}
        onRespond={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("records what was chosen and that a human chose it", () => {
    render(
      <PermissionCard
        row={row({ resolution: { optionId: "once", decidedBy: "operator" } })}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText(/Allow once/)).toBeDefined();
    expect(screen.getByText(/chosen by the operator/)).toBeDefined();
    expect(screen.getByText("Write .env in the worktree")).toBeDefined();
  });

  it("distinguishes a decision nobody made from one an operator made", () => {
    // "policy" means the deadline answered because nobody was there. A review that cannot tell
    // that from a human's yes is reading consent into silence.
    render(
      <PermissionCard
        row={row({ resolution: { optionId: null, decidedBy: "policy" } })}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText(/Declined/)).toBeDefined();
    expect(screen.getByText(/settled by policy/)).toBeDefined();
  });

  it("falls back to the raw option id when the request's own options are not at hand", () => {
    // A resolution can name an option this client never saw — the request can sit in a
    // compacted range while its answer replays — and the id is more use than a blank.
    render(
      <PermissionCard
        row={row({ options: [], resolution: { optionId: "once", decidedBy: "operator" } })}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText(/once/)).toBeDefined();
  });
});
