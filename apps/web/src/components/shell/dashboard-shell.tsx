"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActivityBar } from "./activity-bar";
import { Navigator } from "./navigator";
import { StatusBar } from "./status-bar";

/** VS-Code-style dashboard shell: activity bar + navigator + header'd main + status bar. */
export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const title = pathname.startsWith("/settings")
    ? "Settings"
    : pathname.startsWith("/task/")
      ? "Task"
      : "Board";

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <div className="flex min-h-0 flex-1">
          <ActivityBar />
          <Navigator />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-muted-foreground text-xs uppercase tracking-wider">
              <span>GateControl</span>
              <span className="text-border">/</span>
              <span className="font-medium text-foreground normal-case tracking-normal">
                {title}
              </span>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
          </div>
        </div>
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}
