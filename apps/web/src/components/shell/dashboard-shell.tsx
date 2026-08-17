"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActivityBar } from "./activity-bar";
import { Navigator } from "./navigator";

/** VS-Code-style dashboard shell: activity bar + navigator + a header'd main area. */
export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const title = pathname.startsWith("/settings") ? "Settings" : "Board";

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <ActivityBar />
        <Navigator />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-muted-foreground text-xs uppercase tracking-wider">
            <span>GateControl</span>
            <span className="text-border">/</span>
            <span className="font-medium text-foreground normal-case tracking-normal">{title}</span>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
