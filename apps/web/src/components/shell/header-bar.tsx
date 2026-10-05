"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { projectSectionHref, settingsSectionFor } from "@/lib/navigation";
import { trpc } from "@/trpc/react";
import { CommandPaletteTrigger } from "./command-palette";
import { HeaderActionsOutlet } from "./header-actions";
import { SecondarySidebarToggle } from "./secondary-sidebar";
import { SidebarShowButton } from "./sidebar";
import { type Place, usePlace } from "./use-place";

/**
 * The shell's header: where you are on the left, what you can do on the right.
 *
 * The breadcrumb is a real trail, not a label — every segment but the last is a link — and it
 * states the hierarchy in words: **Projects › Project › Section › leaf.** It starts at Projects,
 * not at the Workspace's name: the Workspace is named at the top of the sidebar, and the root
 * crumb used to link to its *settings*, so the first thing in the trail led out of the app.
 *
 * A Task or an Issue is placed by `usePlace`, which asks the server for its Project; a Task page
 * used to read `Workspace › Task` because its flat route carries no Project, and now reads
 * `Projects › Acme › Board › Fix the login` like every other page under a Project.
 *
 * Nothing in this header creates anything: creating work happens where the thing being created
 * lives, and each of those surfaces puts its own controls here through `HeaderActionsOutlet`.
 */
function Crumb({ href, children }: { href?: string | undefined; children: ReactNode }) {
  if (!href) {
    return (
      <span aria-current="page" className="min-w-0 truncate px-1 font-medium">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="min-w-0 shrink truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </Link>
  );
}

function Separator() {
  return <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />;
}

interface Segment {
  label: string;
  href?: string | undefined;
}

/** The leaf a flat route names: the Task's or the Issue's own title. */
function useLeaf(place: Place): Segment | null {
  const task = trpc.task.get.useQuery({ id: place.taskId ?? "" }, { enabled: !!place.taskId });
  const issue = trpc.issue.get.useQuery(
    { id: place.issueId ?? "" },
    { enabled: !!place.issueId && !place.taskId },
  );
  if (place.taskId) return { label: task.data?.title ?? "Task" };
  if (place.issueId) return { label: issue.data?.title ?? "Issue" };
  return null;
}

function SettingsLeaf() {
  const params = useSearchParams();
  return <Crumb>{settingsSectionFor(params.get("section")).label}</Crumb>;
}

function Trail() {
  const place = usePlace();
  const leaf = useLeaf(place);
  const project = trpc.project.get.useQuery(
    { projectId: place.projectId ?? "" },
    { enabled: place.projectId !== null },
  );

  const segments: Segment[] = [];
  if (place.projectId) {
    segments.push({ label: "Projects", href: "/projects" });
    segments.push({
      label: project.data?.title ?? "Project",
      href: projectSectionHref(place.projectId, ""),
    });
    if (place.projectSection) {
      segments.push({
        label: place.projectSection.label,
        href: projectSectionHref(place.projectId, place.projectSection.path),
      });
    }
  } else if (place.section) {
    segments.push({ label: place.section.label, href: place.section.href });
  }
  if (leaf) segments.push(leaf);

  const inSettings = place.section?.href === "/settings";
  // The last segment is where you are, so it is text rather than a link to itself.
  const last = segments.length - 1;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      {segments.map((segment, i) => (
        <span key={segment.href ?? segment.label} className="flex min-w-0 items-center gap-1">
          {i > 0 && <Separator />}
          <Crumb href={i === last && !inSettings ? undefined : segment.href}>{segment.label}</Crumb>
        </span>
      ))}
      {inSettings && (
        <>
          <Separator />
          <Suspense fallback={null}>
            <SettingsLeaf />
          </Suspense>
        </>
      )}
    </nav>
  );
}

export function HeaderBar() {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <SidebarShowButton />
      <Trail />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <HeaderActionsOutlet />
        {/* The right-hand panel's switch, at the right-hand end of the header — the only chrome
            in this bar that is about the shell rather than about a page. It renders nothing on a
            surface that contributes no panel. */}
        <SecondarySidebarToggle />
        <span className="h-4 w-px bg-border" aria-hidden />
        <CommandPaletteTrigger />
      </div>
    </header>
  );
}
