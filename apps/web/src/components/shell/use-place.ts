"use client";

import { usePathname } from "next/navigation";
import {
  issueIdFromPath,
  PROJECT_SECTIONS,
  type ProjectSection,
  projectIdFromPath,
  projectSectionFor,
  type Section,
  sectionFor,
  taskIdFromPath,
  WORKSPACE_SECTIONS,
} from "@/lib/navigation";
import { trpc } from "@/trpc/react";

/** Where the current page sits in the app's hierarchy — what the sidebar lights and the trail names. */
export interface Place {
  pathname: string;
  /** The Project the page is inside: from the URL, or for a Task or Issue, from the server. */
  projectId: string | null;
  /** Which of that Project's sections to light. */
  projectSection: ProjectSection | null;
  /** The workspace destination the page belongs to, when it is not inside a Project. */
  section: Section | null;
  taskId: string | null;
  issueId: string | null;
}

const BOARD = PROJECT_SECTIONS.find((s) => s.path === "/board") ?? null;
const ISSUES = PROJECT_SECTIONS.find((s) => s.path === "/issues") ?? null;
const UNASSIGNED = WORKSPACE_SECTIONS.find((s) => s.href === "/unassigned") ?? null;

/**
 * One answer to "where am I", shared by the sidebar and the breadcrumb so they cannot disagree.
 *
 * Task and Issue routes are flat (`/task/:id`, `/issues/:id`) — they outlive the view they were
 * opened from — so their Project is not in the URL and has to be asked for. That used to be
 * skipped, and a Task page read `Workspace › Task` with nothing in the sidebar lit: the one page
 * people spend longest on was the one the chrome could not place. A Task is placed on its
 * Project's Board and an Issue on its Project's Issues, which is where each was opened from; an
 * Issue in no Project is placed under Unassigned. While the answer is in flight nothing is lit,
 * rather than a guess that moves a beat later.
 *
 * The queries share their keys with the pages' own (`task.get`, `project.forIssue`), so placing a
 * page costs no request the page was not already making.
 */
export function usePlace(): Place {
  const pathname = usePathname();
  const taskId = taskIdFromPath(pathname);
  const routeIssueId = issueIdFromPath(pathname);
  const routeProjectId = projectIdFromPath(pathname);

  const task = trpc.task.get.useQuery({ id: taskId ?? "" }, { enabled: taskId !== null });
  const issueId = routeIssueId ?? task.data?.issueId ?? null;
  const holder = trpc.project.forIssue.useQuery(
    { issueId: issueId ?? "" },
    { enabled: routeProjectId === null && issueId !== null },
  );

  if (routeProjectId) {
    return {
      pathname,
      projectId: routeProjectId,
      projectSection: projectSectionFor(pathname),
      section: null,
      taskId,
      issueId,
    };
  }

  if (taskId || routeIssueId) {
    const projectId = holder.data?.projectId ?? null;
    const resolvedToNone = holder.isSuccess && projectId === null;
    return {
      pathname,
      projectId,
      projectSection: projectId ? (taskId ? BOARD : ISSUES) : null,
      section: resolvedToNone ? UNASSIGNED : null,
      taskId,
      issueId,
    };
  }

  return {
    pathname,
    projectId: null,
    projectSection: null,
    section: sectionFor(pathname),
    taskId,
    issueId,
  };
}
