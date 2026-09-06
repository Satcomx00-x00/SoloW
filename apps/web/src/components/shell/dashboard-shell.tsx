"use client";

import { type ReactNode, useMemo } from "react";
import { StatusBar } from "@/components/features/status-bar/status-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppContextProvider } from "@/lib/app-context";
import type { AppContext, ShellIdentity } from "@/lib/contributions";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { ActivityBar } from "./activity-bar";
import { CommandPalette } from "./command-palette";
import { HeaderBar } from "./header-bar";
import { Navigator } from "./navigator";
import { SecondarySidebar, SecondarySidebarProvider } from "./secondary-sidebar";

export type { ShellIdentity };

/**
 * VS-Code-style dashboard shell: activity bar + primary sidebar + header'd main + secondary
 * sidebar + status bar.
 *
 * Two sidebars, as in VS Code, because they answer different questions and a single column cannot
 * hold both without one of them losing: the `Navigator` on the left lists what there is to open,
 * the `SecondarySidebar` on the right inspects what is open. The right-hand one is a portal
 * outlet, so it exists only on a surface that fills it — see `secondary-sidebar.tsx`.
 *
 * The shell is where the `AppContext` is published (issue #3), because it is the one component
 * that has the facts a contribution's `when` predicate is judged against and sits above every
 * surface that resolves one — the status bar, the command palette, and the Settings section that
 * arranges them. A surface resolving against a context it built itself would be a second answer
 * to "who is signed in".
 */
export function DashboardShell({
  children,
  identity,
  workspaceName,
}: {
  children: ReactNode;
  /** The signed-in Owner, or null when running on the local dev-owner path. */
  identity: ShellIdentity | null;
  workspaceName: string;
}) {
  const appContext = useMemo<AppContext>(() => ({ identity }), [identity]);

  return (
    <AppContextProvider value={appContext}>
      {/*
        One socket for the app, opened here.

        Above the status bar and above every surface that wants to be live, for the same reason
        the AppContext is published here: several of them listening to the same channel is one
        subscription with several consumers, not several subscriptions.
      */}
      <WorkspaceEventsProvider>
        <TooltipProvider delayDuration={200}>
          <SecondarySidebarProvider>
            <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
              <div className="flex min-h-0 flex-1">
                <ActivityBar signedIn={identity !== null} />
                <Navigator workspaceName={workspaceName} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <HeaderBar workspaceName={workspaceName} />
                  {/*
                `relative` is load-bearing, not decoration.

                This is the SPA's only scrolling region, and without a positioning context on it
                an absolutely-positioned descendant resolves against the *initial* containing
                block instead — so it is neither clipped by this element nor scrolled with it,
                and its static position, far down a long column, stretches the **document**
                past the viewport. The browser then paints a second, page-level scrollbar beside
                this one.

                That is not hypothetical: every Radix `Select` renders a hidden native `<select>`
                at `position: absolute` for form compatibility, and Settings holds a dozen of
                them. The page measured 1524px tall inside an 820px viewport and scrolled in two
                places at once. Making this element the containing block puts those descendants
                back inside the region that owns them, and the document stays exactly `100dvh`.
              */}
                  <div className="flex min-h-0 flex-1">
                    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
                      {children}
                    </main>
                    {/* Inside the header'd column and beside `main`, not beside the whole column:
                      the panel belongs to the document being inspected, so the breadcrumb stays
                      above both and the status bar stays below both. */}
                    <SecondarySidebar />
                  </div>
                </div>
              </div>
              <StatusBar />
            </div>
            <CommandPalette />
          </SecondarySidebarProvider>
        </TooltipProvider>
      </WorkspaceEventsProvider>
    </AppContextProvider>
  );
}
