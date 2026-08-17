import "server-only";

/**
 * Session resolution (BetterAuth). Returns the authenticated Owner's identity and their
 * Workspace, or null when unauthenticated. `workspaceId` originates here — never from
 * client input (Principle V).
 *
 * TODO(Phase 2 — auth wiring): implement with BetterAuth. For local single-user, this
 * resolves the single Owner + their one Workspace. The signature is stable so routers and
 * context depend only on the shape, not the auth mechanism.
 */
export interface ResolvedSession {
  workspaceId: string;
  userId: string;
}

export async function resolveSession(_headers: Headers): Promise<ResolvedSession | null> {
  // Placeholder: real implementation validates the BetterAuth session cookie and looks
  // up the Owner's Workspace. Returns null until wired.
  return null;
}
