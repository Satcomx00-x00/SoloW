import { createDb, SEED_WORKSPACE_A } from "@solow/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { createAuth } from "@/server/auth/auth";
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

  const session = dev
    ? { workspaceId: SEED_WORKSPACE_A, userId: "local-owner" }
    : await resolveSession(requestHeaders);
  if (!session) redirect("/sign-in");

  // Both resolved here so the shell can name the Workspace and the Owner in its first paint.
  // Under the dev-owner stand-in there is no account to name, and the shell says so rather
  // than inventing one.
  const user = dev ? null : (await createAuth().api.getSession({ headers: requestHeaders }))?.user;
  const workspaceName = (await getWorkspaceName(createDb(), session.workspaceId)) ?? "Workspace";

  return (
    <DashboardShell
      identity={user ? { name: user.name, email: user.email } : null}
      workspaceName={workspaceName}
    >
      {children}
    </DashboardShell>
  );
}
