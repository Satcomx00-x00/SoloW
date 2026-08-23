/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskEvent } from "@gatecontrol/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  type PermissionRequest,
  PermissionRequestDialog,
  pendingPermission,
} from "./permission-request-dialog";

/**
 * The operator's side of AC-4. Two properties matter and neither is cosmetic: the dialog offers
 * exactly the options the agent offered — never one GateControl invented — and a question that
 * has already been settled never comes back.
 */

afterEach(cleanup);

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    kind: "permission_request",
    taskId: "task-1",
    sessionId: "sess-1",
    seq: 3,
    toolCallId: null,
    requestId: "req-1",
    title: "Write .env in the worktree",
    toolKind: "edit",
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
    ...over,
  };
}

describe("PermissionRequestDialog", () => {
  it("shows nothing while the agent is not asking anything", () => {
    render(<PermissionRequestDialog request={null} onChoose={() => {}} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders one button per option the agent offered, and no others", () => {
    render(<PermissionRequestDialog request={request()} onChoose={() => {}} />);
    expect(screen.getByText(/Write \.env in the worktree/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined();
    // No dismiss: closing the dialog would leave the operator believing they had declined.
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /always/i })).toBeNull();
  });

  it("reports the option the operator chose, by the agent's own id", () => {
    const chosen: Array<[string, string]> = [];
    render(
      <PermissionRequestDialog
        request={request()}
        onChoose={(requestId, optionId) => chosen.push([requestId, optionId])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(chosen).toEqual([["req-1", "no"]]);
  });

  it("says plainly when the agent offered nothing to choose from", () => {
    render(<PermissionRequestDialog request={request({ options: [] })} onChoose={() => {}} />);
    expect(screen.getByText(/offered no options/)).toBeDefined();
  });

  it("tells the operator that walking away lets the policy decide, and that it refuses by default", () => {
    // Not "the narrowest option is taken automatically": silence is a refusal now (AC-4). It
    // says "by default" because the posture is configurable server-side, and an operator
    // deciding whether to leave the room needs the version that is true on every deployment.
    render(<PermissionRequestDialog request={request()} onChoose={() => {}} />);
    expect(screen.getByText(/unattended permission\s+policy settles it/)).toBeDefined();
    expect(screen.getByText(/by default that is a refusal/)).toBeDefined();
  });
});

describe("pendingPermission", () => {
  const resolved = (requestId: string): TaskEvent => ({
    kind: "permission_resolved",
    taskId: "task-1",
    sessionId: "sess-1",
    seq: 4,
    requestId,
    optionId: "once",
    decidedBy: "operator",
  });

  it("finds the request nobody has answered yet", () => {
    expect(pendingPermission([request()])?.requestId).toBe("req-1");
  });

  it("does not reopen a question already settled — including by the deadline policy", () => {
    // A reconnect replays the request *and* its resolution; pairing them is what stops the
    // dialog reappearing for something that was answered while the socket was down.
    expect(pendingPermission([request(), resolved("req-1")])).toBeNull();
  });

  it("keeps a second, still-open question when an earlier one was answered", () => {
    const events: TaskEvent[] = [
      request(),
      resolved("req-1"),
      request({ requestId: "req-2", title: "Run the test suite" }),
    ];
    expect(pendingPermission(events)?.requestId).toBe("req-2");
  });

  it("opens the dialog again for a later round that reused an earlier request id", () => {
    // The reproduction of the defect that made AC-4 hold for round one only. The stream spans
    // every run of the Task, and an agent process numbers its requests from 1 each time it is
    // spawned, so a round-two question can legitimately arrive wearing a round-one id. Pairing
    // by id alone filtered it out and the operator was never asked; the deadline answered.
    const events: TaskEvent[] = [
      request({ seq: 0 }),
      resolved("req-1"),
      request({ seq: 2, title: "Write .env again" }),
    ];
    expect(pendingPermission(events)?.title).toBe("Write .env again");
  });

  it("shows the older of two questions asked at once, not the newer", () => {
    // Two concurrent tool calls raise two requests. Showing the newest left the older one
    // rendered to nobody until its own deadline settled it — surfaced in name only.
    const events: TaskEvent[] = [
      request({ requestId: "req-1", title: "Write .env", seq: 0 }),
      request({ requestId: "req-2", title: "Run the test suite", seq: 1 }),
    ];
    expect(pendingPermission(events)?.requestId).toBe("req-1");
    // ...and answering it brings the next one up rather than dropping it.
    expect(pendingPermission([...events, resolved("req-1")])?.requestId).toBe("req-2");
  });

  it("finds nothing in a stream that never carried a permission", () => {
    expect(
      pendingPermission([
        {
          kind: "stdout",
          taskId: "task-1",
          sessionId: "sess-1",
          seq: 0,
          text: "working",
          channel: "assistant",
        },
      ]),
    ).toBeNull();
  });
});
