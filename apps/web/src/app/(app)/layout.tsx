import { createDb, LOCAL_WORKSPACE_ID } from "@solow/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { resolveSession } from "@/server/auth/session";
import { getWorkspaceName } from "@/server/dal/workspace";
import { devOwnerMode } from "@/server/env";

/**
 * The signed-in shell (task TASK-011). Guarding here rather than in Next middleware keeps the
 * check on the Node runtime, where the session is resolved against the same database the API
 * uses — middleware runs on the edge runtime and cannot reach `bun:sqlite`.
 *
 * This is a *rendering* guard, not the security boundary: every tRPC procedure re-checks the
 * session and the Workspace itself, so an unauthenticated fetch still fails even if a page were
 * somehow rendered (constitution: authorization re-checked inside every procedure).
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const dev = devOwnerMode();

  // Under the dev-owner stand-in there is no account to name, and the shell says so rather than
  // inventing one — which is what `identity: null` means on both branches.
  const session = dev
    ? { workspaceId: LOCAL_WORKSPACE_ID, userId: "local-owner", identity: null }
    : await resolveSession(requestHeaders);
  if (!session) redirect("/sign-in");

  // The Owner's name comes back with the session that was just verified, rather than from a
  // second `getSession` against the same cookie. That call sat here because the shell needs a
  // name and this function used to return only ids, and it made every authenticated page render
  // decode the cookie and read the session and user rows twice, in series, before painting.
  const workspaceName = (await getWorkspaceName(createDb(), session.workspaceId)) ?? "Workspace";

  return (
    <DashboardShell identity={session.identity} workspaceName={workspaceName}>
      {children}
    </DashboardShell>
  );
}
