/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The sidebar's frame: what it remembers across a reload, and where keyboard focus lands when it
 * is shown or hidden. Its contents are `sidebar-nav.test.tsx`'s.
 *
 * `next/navigation` and the auth client are stubbed completely, for the reasons that file gives.
 */
let pathname = "/settings";
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
mock.module("@/lib/auth-client", () => ({
  signOut: async () => {},
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
}));

const { Sidebar, SidebarProvider, SidebarShowButton } = await import("./sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const handlers = {
  "project.list": () => [],
  "issue.list": () => ({ items: [], nextCursor: null }),
  "preference.getRecentTasks": () => ({ workspaceId: "ws-1", userId: "user-1", taskIds: [] }),
  "preference.recordRecentTask": () => ({ workspaceId: "ws-1", userId: "user-1", taskIds: [] }),
  "workflow.list": () => [],
};

function renderShell(defaultOpen = true) {
  return renderWithTrpc(
    <TooltipProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <SidebarShowButton />
        <Sidebar workspaceName="Acme" signedIn={false} />
      </SidebarProvider>
    </TooltipProvider>,
    handlers,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("Sidebar — Settings' way back", () => {
  it("survives a reload: the back link returns to the page before Settings", async () => {
    // What the tab recorded before the reload; the reload itself starts on Settings.
    window.sessionStorage.setItem("solow.lastAppPath", "/projects/proj-1/board");
    pathname = "/settings";
    renderShell();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Back to app" }).getAttribute("href")).toBe(
        "/projects/proj-1/board",
      ),
    );
  });

  it("falls back to the Projects list in a tab that has been nowhere else", () => {
    pathname = "/settings";
    renderShell();

    expect(screen.getByRole("link", { name: "Back to app" }).getAttribute("href")).toBe(
      "/projects",
    );
  });
});

describe("Sidebar — focus follows ⌘B", () => {
  it("moves focus to the show button when the column is hidden from inside it", async () => {
    pathname = "/projects";
    renderShell();

    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    hide.focus();
    act(() => {
      fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    });

    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull(),
    );
    expect(document.activeElement?.id).toBe("sidebar-show");
  });

  it("moves focus into the column when it is shown from the header", async () => {
    pathname = "/projects";
    renderShell(false);

    const show = screen.getByRole("button", { name: "Show sidebar" });
    show.focus();
    fireEvent.click(show);

    await waitFor(() => expect(document.activeElement?.id).toBe("sidebar-hide"));
  });
});
