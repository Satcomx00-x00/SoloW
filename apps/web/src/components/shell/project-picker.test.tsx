/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The Project switcher on its own (spec F16), below the navigator that hosts it.
 *
 * `navigator.test.tsx` pins that the picker is reachable from every screen and only asks for the
 * list once opened. What it cannot see from there is where a press *goes*, which is the whole
 * behaviour: the section you were on survives the switch, the create entry leads to the page
 * that creates, and a list that failed or has not arrived still leaves that entry in reach.
 *
 * `next/navigation` is stubbed locally for the reason `navigator.test.tsx` gives — a shared
 * partial stub from whichever file bun loads first leaks into the next consumer.
 */
const pushed: string[] = [];
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushed.push(href),
    replace: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/projects/proj-1/board",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { ProjectPicker } = await import("./project-picker");

const PROJECTS = [
  { id: "proj-1", title: "Alpha", itemCount: 3 },
  { id: "proj-2", title: "Beta", itemCount: 0 },
];

function open(section = "/board", handlers: Record<string, (input: unknown) => unknown> = {}) {
  const result = renderWithTrpc(
    <ProjectPicker
      caption="Harness runs, by state"
      projectId="proj-1"
      section={section}
      title="Alpha"
    />,
    { "project.list": () => PROJECTS, ...handlers },
  );
  fireEvent.click(screen.getByRole("button", { name: "Alpha — switch project" }));
  return result;
}

beforeEach(() => {
  pushed.length = 0;
});

afterEach(cleanup);

describe("ProjectPicker", () => {
  it("lands on the same section of the Project you switch to", async () => {
    open("/board");

    fireEvent.click(await screen.findByRole("option", { name: /Beta/ }));

    expect(pushed).toEqual(["/projects/proj-2/board"]);
  });

  it("lands on the overview when the overview is where you were", async () => {
    open("");

    fireEvent.click(await screen.findByRole("option", { name: /Beta/ }));

    expect(pushed).toEqual(["/projects/proj-2"]);
  });

  it("marks the Project you are already in, and only that one", async () => {
    open();

    const current = await screen.findByRole("option", { name: /Alpha/ });
    const other = screen.getByRole("option", { name: /Beta/ });
    expect(current.querySelector(".lucide-check")).not.toBeNull();
    expect(other.querySelector(".lucide-check")).toBeNull();
    // The count is the Project's size, so an empty one reads as empty rather than as missing.
    expect(other.textContent).toContain("0");
  });

  it("closes once a Project is chosen, so the list does not sit over the page it opened", async () => {
    open();

    fireEvent.click(await screen.findByRole("option", { name: /Beta/ }));

    await waitFor(() => expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull());
  });

  it("narrows the list by name, and says so when nothing matches", async () => {
    open();
    await screen.findByRole("option", { name: /Beta/ });
    const search = screen.getByPlaceholderText("Find a project…");

    fireEvent.change(search, { target: { value: "bet" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull());
    expect(screen.getByRole("option", { name: /Beta/ })).toBeDefined();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText("No project matches.")).toBeDefined();
  });

  it("leads to the projects page to create one", async () => {
    open();

    fireEvent.click(await screen.findByRole("option", { name: /New or adopted project/ }));

    expect(pushed).toEqual(["/projects"]);
  });

  it("keeps the way to create a Project while the list has not arrived", async () => {
    // A Workspace with no Projects, or a slow one, must not be a Workspace with no way to make one.
    open("/board", { "project.list": () => new Promise(() => {}) });

    expect(await screen.findByRole("option", { name: /New or adopted project/ })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
  });

  it("keeps the way to create a Project when the list fails", async () => {
    const { log } = open("/board", {
      "project.list": () => {
        throw new Error("database is locked");
      },
    });

    await waitFor(() => expect(log.calls.some((c) => c.path === "project.list")).toBe(true));
    expect(await screen.findByRole("option", { name: /New or adopted project/ })).toBeDefined();
  });
});
