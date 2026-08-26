/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { ProjectViewDto } from "@gatecontrol/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG } from "@gatecontrol/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { moveInOrder, ProjectViewTabs } from "./project-view-tabs";

/**
 * The tab strip (issue #129).
 *
 * The interesting assertions are about the order: it is sent whole on every move, and a move
 * that cannot happen leaves it exactly as it was. A strip that could emit an order missing an id
 * would leave a tab with no position of its own, sorting wherever its stale one happens to land.
 */

afterEach(cleanup);

const view = (id: string, name: string, position: number): ProjectViewDto => ({
  id,
  projectId: "prj-1",
  name,
  position,
  config: DEFAULT_PROJECT_VIEW_CONFIG,
  createdAt: "2026-08-25T09:00:00.000Z",
  updatedAt: "2026-08-25T09:00:00.000Z",
});

const views = [view("v1", "Backlog", 0), view("v2", "Roadmap", 1), view("v3", "Bugs", 2)];

const noop = () => {};

describe("moveInOrder", () => {
  it("swaps a tab with its neighbour, returning the whole order", () => {
    expect(moveInOrder(["v1", "v2", "v3"], "v2", -1)).toEqual(["v2", "v1", "v3"]);
    expect(moveInOrder(["v1", "v2", "v3"], "v2", 1)).toEqual(["v1", "v3", "v2"]);
  });

  it("never drops or repeats an id", () => {
    for (const by of [-1, 1] as const) {
      for (const id of ["v1", "v2", "v3", "missing"]) {
        const moved = moveInOrder(["v1", "v2", "v3"], id, by);
        expect(new Set(moved).size).toBe(3);
        expect([...moved].sort()).toEqual(["v1", "v2", "v3"]);
      }
    }
  });

  it("leaves the order alone at either end", () => {
    expect(moveInOrder(["v1", "v2"], "v1", -1)).toEqual(["v1", "v2"]);
    expect(moveInOrder(["v1", "v2"], "v2", 1)).toEqual(["v1", "v2"]);
  });
});

describe("ProjectViewTabs", () => {
  const strip = (over: Partial<React.ComponentProps<typeof ProjectViewTabs>> = {}) => (
    <ProjectViewTabs
      views={views}
      activeViewId="v2"
      onSelect={noop}
      onCreate={noop}
      onRename={noop}
      onReorder={noop}
      onDelete={noop}
      {...over}
    />
  );

  it("marks exactly the active tab as selected", () => {
    render(strip());

    expect(screen.getByRole("tab", { name: "Roadmap" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Backlog" }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("selects a tab by its name, not by its position", () => {
    const chosen: string[] = [];
    render(strip({ onSelect: (id) => chosen.push(id) }));

    fireEvent.click(screen.getByRole("tab", { name: "Bugs" }));

    expect(chosen).toEqual(["v3"]);
  });

  it("offers a new view even when several already exist", () => {
    const created: string[] = [];
    render(strip({ onCreate: () => created.push("new") }));

    fireEvent.click(screen.getByRole("button", { name: /new view/i }));

    expect(created).toHaveLength(1);
  });
});
