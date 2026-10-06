/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
  issueIdFromPath,
  PROJECT_SECTIONS,
  projectIdFromPath,
  projectSectionFor,
  projectSectionHref,
  SECTIONS,
  sectionFor,
  settingsHref,
  settingsSectionFor,
  settingsSectionsIn,
  taskIdFromPath,
  WORKSPACE_SECTIONS,
  workflowIdFromPath,
} from "./navigation";

/**
 * The shape of the app, read off a path. Every surface that says "where am I" — the sidebar, the
 * breadcrumb, the command palette — reads these, so a path answered wrongly here is answered
 * wrongly everywhere at once.
 */

describe("the destinations", () => {
  it("lists Projects first, then the workspace pages, Settings last", () => {
    expect(WORKSPACE_SECTIONS.map((s) => s.href)).toEqual([
      "/projects",
      "/unassigned",
      "/workflows",
      "/history",
      "/settings",
    ]);
  });

  it("offers the palette exactly the workspace destinations", () => {
    expect(SECTIONS).toBe(WORKSPACE_SECTIONS);
  });

  it("orders a Project's sections the way the work moves: plan, run, read", () => {
    expect(PROJECT_SECTIONS.map((s) => s.label)).toEqual(["Planning", "Board", "Issues"]);
  });

  it("marks only Workflows as unfinished", () => {
    expect(WORKSPACE_SECTIONS.filter((s) => s.wip).map((s) => s.href)).toEqual(["/workflows"]);
  });

  it("never uses one icon for two destinations side by side", () => {
    // Unassigned and a Project's Issues both list issues; one icon for both read as one place.
    const unassigned = WORKSPACE_SECTIONS.find((s) => s.href === "/unassigned");
    const issues = PROJECT_SECTIONS.find((s) => s.path === "/issues");
    expect(unassigned?.icon).not.toBe(issues?.icon);
  });
});

describe("ids read off a path", () => {
  it("finds the Project, and refuses the list and the create route", () => {
    expect(projectIdFromPath("/projects/p-1")).toBe("p-1");
    expect(projectIdFromPath("/projects/p-1/board")).toBe("p-1");
    expect(projectIdFromPath("/projects")).toBeNull();
    expect(projectIdFromPath("/projects/new")).toBeNull();
    expect(projectIdFromPath("/workflows")).toBeNull();
  });

  it("finds a Task, an Issue and a Workflow on their flat routes", () => {
    expect(taskIdFromPath("/task/t-9")).toBe("t-9");
    expect(taskIdFromPath("/tasks")).toBeNull();
    expect(issueIdFromPath("/issues/i-3")).toBe("i-3");
    expect(issueIdFromPath("/projects/p-1/issues")).toBeNull();
    expect(workflowIdFromPath("/workflows/w-2")).toBe("w-2");
    expect(workflowIdFromPath("/workflows")).toBeNull();
  });
});

describe("projectSectionFor", () => {
  it("answers the overview only for the Project's own path", () => {
    expect(projectSectionFor("/projects/p-1")?.label).toBe("Planning");
  });

  it("answers the longest matching section", () => {
    expect(projectSectionFor("/projects/p-1/board")?.label).toBe("Board");
    expect(projectSectionFor("/projects/p-1/issues")?.label).toBe("Issues");
    expect(projectSectionFor("/projects/p-1/issues/extra")?.label).toBe("Issues");
  });

  it("answers nothing outside a Project, or for a path it does not know", () => {
    expect(projectSectionFor("/projects")).toBeNull();
    expect(projectSectionFor("/settings")).toBeNull();
    expect(projectSectionFor("/projects/p-1/elsewhere")).toBeNull();
  });

  it("builds each section's address back from the Project", () => {
    expect(projectSectionHref("p-1", "")).toBe("/projects/p-1");
    expect(projectSectionHref("p-1", "/board")).toBe("/projects/p-1/board");
  });
});

describe("sectionFor", () => {
  it("finds the workspace destination a path belongs to", () => {
    expect(sectionFor("/projects")?.label).toBe("Projects");
    expect(sectionFor("/projects/p-1/board")?.label).toBe("Projects");
    expect(sectionFor("/workflows/w-2")?.label).toBe("Workflows");
    expect(sectionFor("/settings")?.label).toBe("Settings");
  });

  it("does not guess where a Task lives — the server is asked instead", () => {
    expect(sectionFor("/task/t-9")).toBeNull();
  });

  it("does not match a destination by prefix alone", () => {
    expect(sectionFor("/historyish")).toBeNull();
    expect(sectionFor("/sign-in")).toBeNull();
  });
});

describe("settings sections", () => {
  it("opens on the first section for no id, an unknown one, or an old #anchor", () => {
    const first = settingsSectionFor(null);
    expect(settingsSectionFor(undefined)).toBe(first);
    expect(settingsSectionFor("nope")).toBe(first);
    expect(settingsSectionFor("#secrets").id).toBe("secrets");
  });

  it("groups every section under exactly one group", () => {
    const grouped = (["Workspace", "Connections", "Harnesses", "Extensions", "Interface"] as const)
      .flatMap((g) => settingsSectionsIn(g))
      .map((s) => s.id);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped).toContain("secrets");
  });

  it("addresses a section by query, not by fragment", () => {
    expect(settingsHref("secrets")).toBe("/settings?section=secrets");
  });
});
