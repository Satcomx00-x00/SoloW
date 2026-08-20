"use client";

import { type ReactNode, useMemo } from "react";
import { StatusBar } from "@/components/features/status-bar/status-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppContextProvider } from "@/lib/app-context";
import type { AppContext, ShellIdentity } from "@/lib/contributions";
import { ActivityBar } from "./activity-bar";
import { CommandPalette } from "./command-palette";
import { HeaderBar } from "./header-bar";
import { Navigator } from "./navigator";

export type { ShellIdentity };

/**
 * VS-Code-style dashboard shell: activity bar + navigator + header'd main + status bar.
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
      <TooltipProvider delayDuration={200}>
        <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
          <div className="flex min-h-0 flex-1">
            <ActivityBar signedIn={identity !== null} />
            <Navigator workspaceName={workspaceName} />
            <div className="flex min-w-0 flex-1 flex-col">
              <HeaderBar workspaceName={workspaceName} />
              <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
            </div>
          </div>
          <StatusBar />
        </div>
        <CommandPalette />
      </TooltipProvider>
    </AppContextProvider>
  );
}
