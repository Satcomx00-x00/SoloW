"use client";

import { FolderGit2, Inbox, Table2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";
import { AdoptProjectDialog } from "./adopt-project-dialog";
import { CreateLocalProjectDialog } from "./create-local-project-dialog";

/**
 * The hub: every Project, and the way in to a new one.
 *
 * This is the app's front door (F23). A Project is the top level — issues, boards and workflows
 * are all read inside one — so the first screen has to be the list of them, not a board that
 * implies work exists in a flat pile at workspace level.
 *
 * The empty state does the onboarding the old flat rail never had a place for: it says what a
 * Project *is* here (a mirror of one that already exists on a provider, never one SoloW
 * creates — Decision 0018) and offers the one action that gets you past it.
 */
export function ProjectsHub() {
  const router = useRouter();
  const projects = trpc.project.list.useQuery({});
  // The escape hatch's size, shown as a number rather than a permanent menu entry: it matters
  // when it is not zero and is noise when it is.
  const unassigned = trpc.issue.list.useQuery({ ...WHOLE_PAGE, unassigned: true });

  if (projects.isPending) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const rows = projects.data ?? [];

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FolderGit2 aria-hidden className="size-9 text-muted-foreground/40" />
        <h1 className="font-semibold text-base">Start with a project</h1>
        <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
          Everything in SoloW lives inside a project: the issues it holds, the board its agents run
          on, the workflows that chain them. A project is <em>mirrored</em> from GitHub or GitLab —
          SoloW never creates one on your provider. If your tracker has nothing like that to mirror,
          create one here instead — SoloW still creates nothing on your provider, only in itself.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <AdoptProjectDialog onAdopted={(id) => router.push(`/projects/${id}`)} />
          <CreateLocalProjectDialog onCreated={(id) => router.push(`/projects/${id}`)} />
        </div>
        {(unassigned.data?.items ?? []).length > 0 && (
          <p className="pt-4 text-2xs text-muted-foreground/70">
            {/* Never a dead end: issues imported before any project existed still have a screen,
                or the Tasks under them would go out of reach with them. */}
            <Link href="/unassigned" className="hover:underline">
              {unassigned.data?.items.length} issue
              {unassigned.data?.items.length === 1 ? "" : "s"} belong to no project yet
            </Link>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-6 py-6">
      <header className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-semibold text-lg tracking-[-0.01em]">Projects</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Pick a project to plan it, run agents on it, and review what they change.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdoptProjectDialog onAdopted={(id) => router.push(`/projects/${id}`)} />
          <CreateLocalProjectDialog onCreated={(id) => router.push(`/projects/${id}`)} />
        </div>
      </header>

      <ul className="space-y-2.5">
        {rows.map((project) => (
          <li key={project.id}>
            <Link href={`/projects/${project.id}`} className="block">
              <Card className="gap-0 py-4 transition-colors hover:border-ring/40 hover:bg-accent/30">
                <CardHeader className="px-4">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Table2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{project.title}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pt-1.5">
                  <span className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                    {/* The row count, not the field count: the list read does not load a
                        Project's fields, so `fields: []` there means "not loaded" and printing
                        its length said "0 fields" over a project with nineteen. */}
                    <Badge variant="outline" className="font-mono tabular-nums">
                      {project.itemCount} item{project.itemCount === 1 ? "" : "s"}
                    </Badge>
                    {/* Staleness said out loud rather than implied by an old number — F23 NFR-3. */}
                    <span>
                      {project.syncedAt
                        ? `Synced ${new Date(project.syncedAt).toLocaleString()}`
                        : "Never synced"}
                    </span>
                  </span>
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>

      {(unassigned.data?.items ?? []).length > 0 && (
        <Link
          href="/unassigned"
          className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs transition-colors hover:bg-accent/30 hover:text-foreground"
        >
          <Inbox aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {unassigned.data?.items.length} issue{unassigned.data?.items.length === 1 ? "" : "s"}{" "}
            belong to no project
          </span>
        </Link>
      )}
    </div>
  );
}
