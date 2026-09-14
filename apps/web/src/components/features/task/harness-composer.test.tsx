/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { matchSteers } from "./composer-steers";
import { HarnessComposer } from "./harness-composer";

/**
 * The composer on its own: the keys that send and the keys that do not, the slash menu, and the
 * two things the frame now says for itself — a message waiting for the stream, and the hub's
 * refusal of the last one.
 */

afterEach(cleanup);

function Harness({
  canSteer = true,
  isRunning = true,
  queued = null,
  ackError = null,
  onSubmit,
  onStop = () => {},
  onQueueStop = () => {},
  stopQueued = false,
}: {
  canSteer?: boolean;
  isRunning?: boolean;
  queued?: string | null;
  ackError?: string | null;
  onSubmit: (value: string) => void;
  onStop?: () => void;
  onQueueStop?: () => void;
  stopQueued?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <HarnessComposer
      value={value}
      onChange={setValue}
      onSubmit={() => onSubmit(value)}
      onStop={onStop}
      canSteer={canSteer}
      isRunning={isRunning}
      queued={queued}
      onDiscardQueued={() => {}}
      stopQueued={stopQueued}
      onQueueStop={onQueueStop}
      onDiscardStop={() => {}}
      ackError={ackError}
    />
  );
}

describe("HarnessComposer keys", () => {
  it("sends on ⌘↩ / Ctrl↩ and breaks the line on a bare Enter", () => {
    const sent: string[] = [];
    render(<Harness onSubmit={(v) => sent.push(v)} />);
    const box = screen.getByLabelText("Message the harness");

    fireEvent.change(box, { target: { value: "first line" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sent).toEqual([]);

    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(sent).toEqual(["first line", "first line"]);
  });

  it("is a textarea, so a steer can be a paragraph", () => {
    render(<Harness onSubmit={() => {}} />);
    expect(screen.getByLabelText("Message the harness").tagName).toBe("TEXTAREA");
  });
});

describe("HarnessComposer slash steers", () => {
  it("narrows by prefix: `/st` offers status and stop, nothing else", () => {
    expect(matchSteers("/st").map((s) => s.command)).toEqual(["status", "stop"]);
    expect(matchSteers("/").length).toBeGreaterThan(2);
    // A slash inside a real message is the operator's own text.
    expect(matchSteers("/status please")).toEqual([]);
    expect(matchSteers("see /etc/hosts")).toEqual([]);
  });

  it("expands a picked steer into the box, and Escape clears the menu", () => {
    render(<Harness onSubmit={() => {}} />);
    const box = screen.getByLabelText("Message the harness") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "/te" } });
    const menu = screen.getByRole("listbox", { name: "Steers" });
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toMatch(/test suite/);
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(box, { target: { value: "/" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
  });

  it("walks the menu with the arrows and picks the highlighted row", () => {
    render(<Harness onSubmit={() => {}} />);
    const box = screen.getByLabelText("Message the harness") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "/" } });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toMatch(/Wrap up/);
  });

  it("/stop hands over to the Stop button, which has to be held — a menu cannot hold for you", async () => {
    let stopped = 0;
    render(<Harness onSubmit={() => {}} onStop={() => stopped++} />);
    const box = screen.getByLabelText("Message the harness") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "/stop" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("");
    const stop = screen.getByRole("button", { name: /Stop/ });
    expect(document.activeElement).toBe(stop);
    expect(screen.getByRole("status").textContent).toMatch(/Hold Stop/);
    expect(stopped).toBe(0);
    // Space held for the length of the fill is the keyboard's hold.
    fireEvent.keyDown(stop, { key: " " });
    await waitFor(() => expect(stopped).toBe(1));
  });

  it("a click on Stop does nothing, and letting go early cancels the hold", async () => {
    let stopped = 0;
    render(<Harness onSubmit={() => {}} onStop={() => stopped++} />);
    const stop = screen.getByRole("button", { name: /Stop/ });
    fireEvent.click(stop);
    fireEvent.pointerDown(stop, { button: 0 });
    fireEvent.pointerUp(stop);
    await new Promise((r) => setTimeout(r, 500));
    expect(stopped).toBe(0);
  });

  it("offers no field at all when there is no harness to steer — a sentence, not dead controls", () => {
    render(<Harness onSubmit={() => {}} isRunning={false} />);
    expect(screen.queryByLabelText("Message the harness")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send|Stop/ })).toBeNull();
    expect(screen.getByText(/Not running/)).toBeDefined();
  });
});

describe("HarnessComposer frame", () => {
  it("keeps the box open while the stream is away, and names the message waiting", () => {
    render(<Harness onSubmit={() => {}} canSteer={false} queued="also bump the version" />);
    const box = screen.getByLabelText("Message the harness");
    expect(box.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Queued — sends when the stream is back/).textContent).toContain(
      "also bump the version",
    );
    // Stop stays live too: held now, it is queued for the stream rather than refused.
    const stop = screen.getByRole("button", { name: /Stop/ });
    expect(stop.hasAttribute("disabled")).toBe(false);
  });

  it("queues a stop held while the stream is away, and names it in the frame", async () => {
    let queued = 0;
    let stopped = 0;
    const { rerender } = render(
      <Harness
        onSubmit={() => {}}
        canSteer={false}
        onStop={() => stopped++}
        onQueueStop={() => queued++}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: /Stop/ }), { button: 0 });
    await waitFor(() => expect(queued).toBe(1));
    expect(stopped).toBe(0);
    rerender(<Harness onSubmit={() => {}} canSteer={false} stopQueued />);
    expect(screen.getByText(/Stop queued/)).toBeDefined();
  });

  it("says the hub's refusal inside the frame, in words", () => {
    render(<Harness onSubmit={() => {}} ackError="widget_not_pending" />);
    const form = screen.getByRole("alert").closest("form");
    expect(form).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/already answered/);
  });
});
