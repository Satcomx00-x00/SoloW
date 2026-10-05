/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { TaskDto } from "@solow/contracts";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The sidebar (Decision 0029): one column that lists the same destinations on every route, with
 * the current one filled and the open Project's sections nested under it.
 *
 * `next/navigation` is stubbed locally rather than shared, for the reason `board.test.tsx`
 * documents: a partial stub from whichever sibling file bun loads first leaks into the next.
 */
let pathname = "/projects";
let search = new URLSearchParams();
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => search,
  useParams: () => ({}),
}));

// Complete, not just what this file needs: sign-in-form.test.tsx's own stub of this module has
// both signIn and signUp, and an incomplete stub registered after it leaks a "signUp not found"
// SyntaxError into whichever file next imports the real specifier.
mock.module("@/lib/auth-client", () => ({
  signOut: async () => {},
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
}));

const { SidebarNav } = await import("./sidebar-nav");
const { HeaderBar } = await import("./header-bar");

const AT = "2026-08-20T00:00:00.000Z";

function task(over: Partial<TaskDto> & { id: string }): TaskDto {
  return {
    issueId: "issue-1",
    title: "Untitled",
    state: "backlog",
    agentProfileId: "harness-1",
    executorProfileId: "exec-1",
    repositories: [],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    workflowId: null,
    workflowStepId: null,
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as TaskDto;
}

const RECENTS = (taskIds: string[]) => ({ workspaceId: "ws-1", userId: "user-1", taskIds });

function handlers(extra: Record<string, (input: unknown) => unknown> = {}) {
  return {
    "project.list": () => [
      { id: "proj-1", title: "Features ToDeb", itemCount: 36 },
      { id: "proj-2", title: "GlabTest", itemCount: 4 },
    ],
    "project.get": (input: unknown) => {
      const { projectId } = input as { projectId: string };
      return { id: projectId, title: projectId === "proj-1" ? "Features ToDeb" : "GlabTest" };
    },
    "workspace.counts": () => ({ unassignedIssues: 2 }),
    "preference.getRecentTasks": () => RECENTS([]),
    "preference.recordRecentTask": () => RECENTS([]),
    "workflow.list": () => [],
    ...extra,
  };
}

function current(): HTMLElement[] {
  return screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
}

afterEach(() => {
  cleanup();
  search = new URLSearchParams();
});

describe("Sidebar — the same destinations everywhere", () => {
  it("links the Projects list, every Project, and the workspace pages from a page in none", async () => {
    pathname = "/history";
    renderWithTrpc(<SidebarNav workspaceName="Acme" signedIn={false} />, handlers());

    const projects = screen.getByRole("navigation", { name: "Projects" });
    expect(within(projects).getByRole("link", { name: "All projects" }).getAttribute("href")).toBe(
      "/projects",
    );
    expect(await within(projects).findByRole("link", { name: /GlabTest/ })).toBeDefined();

    const workspace = screen.getByRole("navigation", { name: "Workspace" });
    expect(
      within(workspace)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/unassigned", "/workflows", "/history"]);
    expect(current().map((l) => l.textContent)).toEqual(["History"]);
  });

  it("counts the unassigned Issues beside their entry", async () => {
    pathname = "/projects";
    renderWithTrpc(<SidebarNav workspaceName="Acme" signedIn={false} />, handlers());

    const row = screen.getByRole("link", { name: /Unassigned/ });
    await waitFor(() => expect(row.textContent).toContain("2"));
  });
});

describe("Sidebar — counts stay current", () => {
  it("re-reads the counts when a mutation in this tab succeeds", async () => {
    // Visiting a Task records it as recent — a mutation, so the counts are read again after it.
    pathname = "/task/t1";
    const { log } = renderWithTrpc(
      <SidebarNav workspaceName="Acme" signedIn={false} />,
      handlers({
        "task.get": (input) => task({ id: (input as { id: string }).id }),
        "project.forIssue": () => ({ projectId: "proj-1" }),
      }),
    );

    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === "workspace.counts").length).toBeGreaterThan(1),
    );
  });
});

describe("Sidebar — inside a Project", () => {
  it("nests the open Project's sections and fills exactly the current one", async () => {
    pathname = "/projects/proj-1/board";
    renderWithTrpc(<SidebarNav workspaceName="Acme" signedIn={false} />, handlers());

    const sections = await screen.findByRole("list", { name: "Features ToDeb sections" });
    expect(
      within(sections)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Planning", "Board", "Issues"]);
    expect(current().map((l) => l.textContent)).toEqual(["Board"]);
    // The other Project stays folded.
    expect(screen.queryByRole("list", { name: "GlabTest sections" })).toBeNull();
  });

  it("switches Project into the same section", async () => {
    pathname = "/projects/proj-1/issues";
    renderWithTrpc(<SidebarNav workspaceName="Acme" signedIn={false} />, handlers());

    const other = await screen.findByRole("link", { name: /GlabTest/ });
    expect(other.getAttribute("href")).toBe("/projects/proj-2/issues");
  });
});

describe("Sidebar — a Task page is placed in its Project", () => {
  it("lights the holding Project's Board and records the visit", async () => {
    pathname = "/task/t1";
    const { log } = renderWithTrpc(
      <SidebarNav workspaceName="Acme" signedIn={false} />,
      handlers({
        "task.get": (input) => task({ id: (input as { id: string }).id, title: "Fix the latch" }),
        "project.forIssue": () => ({ projectId: "proj-2" }),
      }),
    );

    const sections = await screen.findByRole("list", { name: "GlabTest sections" });
    await waitFor(() =>
      expect(
        within(sections).getByRole("link", { name: "Board" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
    await waitFor(() =>
      expect(log.calls.some((c) => c.path === "preference.recordRecentTask")).toBe(true),
    );
  });

  it("places a Task whose Issue is in no Project under Unassigned", async () => {
    pathname = "/task/t1";
    renderWithTrpc(
      <SidebarNav workspaceName="Acme" signedIn={false} />,
      handlers({
        "task.get": (input) => task({ id: (input as { id: string }).id }),
        "project.forIssue": () => ({ projectId: null }),
      }),
    );

    await waitFor(() => expect(current().map((l) => l.textContent)).toEqual(["Unassigned2"]));
  });
});

describe("Sidebar — Workflows", () => {
  it("nests the pipelines under Workflows only while it is open, lighting the first on /workflows", async () => {
    pathname = "/workflows";
    renderWithTrpc(
      <SidebarNav workspaceName="Acme" signedIn={false} />,
      handlers({
        "workflow.list": () => [
          { id: "wf-1", name: "Plan, build, review", stepCount: 3, version: 2 },
          { id: "wf-2", name: "Bug fix", stepCount: 2, version: 1 },
        ],
      }),
    );

    const list = await screen.findByRole("list", { name: "Workflows" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/workflows/wf-1", "/workflows/wf-2"]);
    expect(current().map((l) => l.textContent)).toEqual(["Plan, build, review"]);
  });
});

describe("Sidebar — Recent tasks", () => {
  it("is absent when nothing has been visited yet", async () => {
    pathname = "/projects";
    renderWithTrpc(<SidebarNav workspaceName="Acme" signedIn={false} />, handlers());

    await screen.findByRole("link", { name: /GlabTest/ });
    expect(screen.queryByRole("navigation", { name: "Recent tasks" })).toBeNull();
  });

  it("lists the saved Tasks, most recent first, leaving out the one that is open", async () => {
    pathname = "/task/t3";
    renderWithTrpc(
      <SidebarNav workspaceName="Acme" signedIn={false} />,
      handlers({
        "preference.getRecentTasks": () => RECENTS(["t3", "t2", "t1"]),
        "project.forIssue": () => ({ projectId: "proj-1" }),
        "task.get": (input) => {
          const { id } = input as { id: string };
          return task({ id, title: { t1: "Add farewell()", t2: "Fix the gate latch" }[id] ?? id });
        },
      }),
    );

    const recent = await screen.findByRole("navigation", { name: "Recent tasks" });
    await waitFor(() =>
      expect(
        within(recent)
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual(["Fix the gate latch", "Add farewell()"]),
    );
  });
});

describe("Sidebar — Settings", () => {
  it("takes the column over with its own sections and a way back", async () => {
    pathname = "/settings";
    search = new URLSearchParams("section=secrets");
    renderWithTrpc(<SidebarNav workspaceName="Acme" signedIn={false} />, handlers());

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: "Back to app" })).toBeDefined();
    expect(current().map((l) => l.textContent)).toEqual(["Secrets"]);
    expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();
  });
});

describe("Breadcrumb", () => {
  function crumbs(): string[] {
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    return [...trail.querySelectorAll("a, [aria-current]")].map((el) => el.textContent ?? "");
  }

  it("starts at Projects and names the Project and section", async () => {
    pathname = "/projects/proj-1/board";
    renderWithTrpc(<HeaderBar />, handlers());

    await waitFor(() => expect(crumbs()).toEqual(["Projects", "Features ToDeb", "Board"]));
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Projects" }).getAttribute("href")).toBe(
      "/projects",
    );
  });

  it("places a Task under its Project's board, ending on the Task's title", async () => {
    pathname = "/task/t1";
    renderWithTrpc(
      <HeaderBar />,
      handlers({
        "task.get": () => task({ id: "t1", title: "Fix the latch" }),
        "project.forIssue": () => ({ projectId: "proj-1" }),
      }),
    );

    await waitFor(() =>
      expect(crumbs()).toEqual(["Projects", "Features ToDeb", "Board", "Fix the latch"]),
    );
  });

  it("names the Settings section that is open", async () => {
    pathname = "/settings";
    search = new URLSearchParams("section=secrets");
    renderWithTrpc(<HeaderBar />, handlers());

    await waitFor(() => expect(crumbs()).toEqual(["Settings", "Secrets"]));
  });
});
