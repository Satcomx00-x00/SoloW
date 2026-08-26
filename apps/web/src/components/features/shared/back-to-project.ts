"use client";

import { trpc } from "@/trpc/react";

/**
 * Where "back" goes from a screen reached by a flat route.
 *
 * A Task lives at `/task/:id` and an Issue at `/issues/:id` — flat on purpose, because both
 * outlive the view they were opened from and burying their ids under a Project's would break
 * every stored link the moment the Issue moved between Projects. The cost is that neither page
 * knows, from its own address, which Project it belongs to; this asks.
 *
 * The fallback is never a dead end: an Issue in no Project has the unassigned screen, and an
 * answer still in flight uses the Projects hub rather than rendering a link that changes under
 * the cursor a moment later.
 */
export function useBackToProject(
  issueId: string | undefined,
  section: "" | "/board" | "/issues",
): { href: string; label: string } {
  const found = trpc.project.forIssue.useQuery(
    { issueId: issueId ?? "" },
    { enabled: Boolean(issueId) },
  );
  const projectId = found.data?.projectId ?? null;

  if (projectId) {
    return {
      href: `/projects/${projectId}${section}`,
      label: section === "/board" ? "Back to the project board" : "Back to the project",
    };
  }
  // Resolved, and the answer is "no project" — the escape hatch is the honest destination.
  if (found.isSuccess) return { href: "/unassigned", label: "Back to unassigned issues" };
  return { href: "/projects", label: "Back to projects" };
}
