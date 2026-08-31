"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { projectIdFromPath, projectSectionFor, sectionFor } from "@/lib/navigation";
import { trpc } from "@/trpc/react";
import { CommandPaletteTrigger } from "./command-palette";
import { HeaderActionsOutlet } from "./header-actions";

/**
 * The shell's header: where you are on the left, what you can do on the right.
 *
 * The breadcrumb is a real trail, not a label — every segment but the last is a link, so a Task
 * page has a one-click way back that is not the browser's Back button.
 *
 * Its shape is the hierarchy stated in words: **Workspace › Project › Section › leaf.** That
 * middle segment is the whole change — the trail used to read `Workspace › Board`, which said a
 * board was a thing the Workspace had. It is not; it is a thing a Project has, and the crumb now
 * says so on every screen and links back to the Project rather than to a flat list.
 *
 * Nothing in this header creates anything any more. A global `Create` split-button used to sit
 * here on the argument that making a Task or an Issue is not a property of the route you are on —
 * true, but it bought a permanently visible button for actions that are reached from the place
 * they belong to anyway, and a header control that is nearly never the next thing you want is
 * cost with no matching use. It was removed on request, and the ⌘⇧T / ⌘⇧I shortcuts and the
 * palette's four create commands went with it: they existed only to open the dialogs that menu
 * owned, so keeping them would have left key bindings dispatching at nothing.
 *
 * Creating work now happens where the thing being created lives — a Project's own `New` menu,
 * `New task` on an Issue's page — and each of those surfaces mounts its own dialog, so a button
 * cannot ask for something nothing is listening for. `HeaderActionsOutlet` stays for controls
 * that genuinely do belong to one page.
 */
function Crumb({ href, children }: { href?: string | undefined; children: React.ReactNode }) {
  if (!href) return <span className="truncate px-1 font-medium">{children}</span>;
  return (
    <Link
      href={href}
      className="shrink-0 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </Link>
  );
}

function Separator() {
  return <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />;
}

export function HeaderBar({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);
  const projectSection = projectSectionFor(pathname);
  const section = sectionFor(pathname);

  // Named, not just identified: a crumb reading the project's id would be a worse label than no
  // crumb at all. Only asked for when there is a Project in the path.
  const project = trpc.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );

  // A Task's own title is fetched by the page, not here; the shell only knows it is *a* task.
  const leaf = pathname.startsWith("/task/")
    ? "Task"
    : pathname.startsWith("/issues/")
      ? "Issue"
      : null;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        {/* The trail's root, and now a place you can actually go: the Workspace owns everything
            downstream of it in this crumb, and it was the one link in the chain that led
            nowhere. */}
        <Link
          href="/settings?section=workspace"
          className="shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground"
          title={`Workspace: ${workspaceName}`}
        >
          {workspaceName}
        </Link>

        {projectId ? (
          <>
            <Separator />
            {/* Always a link, even on the Project's own overview: it is the trail's real hinge,
                and the one crumb someone reaches for to get back out of a section. */}
            <Crumb
              href={projectSection?.path === "" && !leaf ? undefined : `/projects/${projectId}`}
            >
              {project.data?.title ?? "Project"}
            </Crumb>
            {projectSection && projectSection.path !== "" && (
              <>
                <Separator />
                <Crumb href={leaf ? `/projects/${projectId}${projectSection.path}` : undefined}>
                  {projectSection.label}
                </Crumb>
              </>
            )}
          </>
        ) : (
          /*
           * No section crumb on a Task's own page.
           *
           * `/task/:id` is a flat route, so the trail has nothing in it to say which Project the
           * Task belongs to — and `sectionFor` answers "Projects" for every one of them, which
           * is a guess. It reads as a fact: a Task whose Issue is in no Project at all showed
           * `Workspace › Projects › Task`, naming a container it is not in. Saying less is the
           * honest option, and the crumb was never a link on this route anyway.
           */
          !pathname.startsWith("/task/") &&
          section && (
            <>
              <Separator />
              <Crumb href={leaf ? section.href : undefined}>{section.label}</Crumb>
            </>
          )
        )}

        {leaf && (
          <>
            <Separator />
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
