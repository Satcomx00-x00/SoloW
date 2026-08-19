"use client";

import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActivityBar } from "./activity-bar";
import { CommandPalette } from "./command-palette";
import { HeaderBar } from "./header-bar";
import { Navigator } from "./navigator";
import { type ShellIdentity, StatusBar } from "./status-bar";

/** VS-Code-style dashboard shell: activity bar + navigator + header'd main + status bar. */
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
  return (
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
        <StatusBar identity={identity} />
      </div>
      <CommandPalette />
    </TooltipProvider>
  );
}
