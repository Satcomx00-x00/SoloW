"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BOARD_COLUMNS, STATE_BADGE, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-3 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
      {children}
    </p>
  );
}

/** Board context: live per-state task counts. */
function BoardNav() {
  const tasks = trpc.task.list.useQuery({});
  const counts = (tasks.data ?? []).reduce<Record<string, number>>((acc, t) => {
    acc[t.state] = (acc[t.state] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <nav className="p-2" aria-label="Board lifecycle">
      <SectionLabel>Lifecycle</SectionLabel>
      <ul className="space-y-px">
        {BOARD_COLUMNS.map((state) => (
          <li
            key={state}
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-muted-foreground text-sm"
          >
            <span>{STATE_LABELS[state]}</span>
            <Badge variant={STATE_BADGE[state]}>{counts[state] ?? 0}</Badge>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const SETTINGS_SECTIONS = [
  { id: "secrets", label: "Secrets" },
  { id: "agent-profiles", label: "Agent profiles" },
  { id: "executor-profiles", label: "Executor profiles" },
  { id: "repositories", label: "Repositories" },
];

/** Settings context: anchors to the configuration sections. */
function SettingsNav() {
  return (
    <nav className="p-2" aria-label="Settings sections">
      <SectionLabel>Configuration</SectionLabel>
      <ul className="space-y-px">
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="block rounded-md px-2 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** VS-Code-style navigator: the context panel next to the activity bar. */
export function Navigator() {
  const pathname = usePathname();
  const isSettings = pathname.startsWith("/settings");
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <span className="font-semibold text-sm">{isSettings ? "Settings" : "Workspace"}</span>
      </div>
      <ScrollArea className="flex-1">{isSettings ? <SettingsNav /> : <BoardNav />}</ScrollArea>
    </aside>
  );
}
