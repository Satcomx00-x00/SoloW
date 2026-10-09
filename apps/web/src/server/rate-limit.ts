import "server-only";

/**
 * In-memory fixed-window rate limiter (plan §12 / task TASK-011). v1 is local single-user, so
 * an in-process counter keyed by `${procedure}:${workspaceId}` is sufficient; the hosted path
 * would swap this for a shared store. Applied to the sensitive writes `secret.set` and
 * `task.launch` (Principle IV — bound credential writes and harness launches per Owner).
 */

export interface RateLimitRule {
  /** Max allowed calls within the window. */
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  "secret.set": { limit: 10, windowMs: 60_000 },
  "task.launch": { limit: 20, windowMs: 60_000 },
  /*
   * Three an hour. Not because a reset is expensive, but because it is the one write with no
   * undo: a loop that reached it — a retried mutation, a wedged client — would empty the
   * Workspace repeatedly and each pass would look like it succeeded.
   */
  "workspace.reset": { limit: 3, windowMs: 3_600_000 },
  /*
   * The transcript window moves the line the hourly sweep deletes up to; a looping client should
   * run out of attempts. The preview walks every finished transcript to size it, and Settings
   * asks it once per window chosen — a person never needs thirty a minute.
   */
  "workspace.setHistoryRetention": { limit: 10, windowMs: 60_000 },
  "workspace.previewHistoryRetention": { limit: 30, windowMs: 60_000 },
  /*
   * The setup's test run is a real prompt on the Owner's own credential. A person presses it a
   * few times while fixing a token; a client stuck in a retry loop would otherwise spend tokens.
   */
  "setup.test": { limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitedProcedure = keyof typeof RATE_LIMITS;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Returns true if the call is allowed; false if it exceeds the window's limit. */
export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return true;
  }
  if (bucket.count >= rule.limit) return false;
  bucket.count += 1;
  return true;
}

/** Test hook: clear all windows so limits are deterministic between cases. */
export function resetRateLimits(): void {
  buckets.clear();
}
