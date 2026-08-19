"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionFor } from "@/lib/navigation";
import { CommandPaletteTrigger } from "./command-palette";
import { HeaderActionsOutlet } from "./header-actions";

/**
 * The shell's header: where you are on the left, what you can do on the right.
 *
 * The breadcrumb is a real trail, not a label — the section segment is a link, so a Task page
 * has a one-click way back that is not the browser's Back button. Page-level controls arrive
 * through `HeaderActionsOutlet`, which is why the board no longer carries its own action band
 * directly beneath this one.
 */
export function HeaderBar({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  // A Task's own title is fetched by the page, not here; the shell only knows it is *a* task.
  const leaf = pathname.startsWith("/task/")
    ? "Task"
    : pathname.startsWith("/issues/")
      ? "Issue"
      : null;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <span className="truncate text-muted-foreground">{workspaceName}</span>
        {section && (
          <>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
            {leaf ? (
              <Link
                href={section.href}
                className="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {section.label}
              </Link>
            ) : (
              <span className="truncate px-1 font-medium">{section.label}</span>
            )}
          </>
        )}
        {leaf && (
          <>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
            <span className="truncate px-1 font-medium">{leaf}</span>
          </>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <HeaderActionsOutlet />
        <span className="h-4 w-px bg-border" aria-hidden />
        <CommandPaletteTrigger />
      </div>
    </header>
  );
}
