import { z } from "zod";

/**
 * Shared primitives for every contract.
 *
 * Tenancy rule (constitution Principle V): `workspaceId` is the tenant key and is
 * NEVER part of an input schema — it is derived from the authenticated session on the
 * server. Input schemas here therefore never declare it.
 */

export const idSchema = z.string().min(1);

export const timestampsSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Task lifecycle states (spec: Domain Model / F02). */
export const taskStateSchema = z.enum([
  "backlog",
  "ready",
  "running",
  "review",
  "parked",
  "failed",
  "done",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

/** Issue lifecycle states. */
export const issueStatusSchema = z.enum(["open", "in_progress", "resolved", "closed"]);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

/** Session states. */
export const sessionStateSchema = z.enum(["active", "awaiting_review", "resumable", "closed"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Agent authentication / billing mode (spec F06). */
export const authModeSchema = z.enum(["subscription", "api_key"]);
export type AuthMode = z.infer<typeof authModeSchema>;

/** Review decisions (spec F10). */
export const reviewDecisionSchema = z.enum(["approve", "reject", "request_changes"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/** Repository source (clarified 2026-08-17: local path OR remote URL). */
export const repositorySourceSchema = z.enum(["local_path", "remote_url"]);
export type RepositorySource = z.infer<typeof repositorySourceSchema>;

/**
 * Executor kinds live in `executor-config.ts`, beside the per-kind configuration union they
 * must stay in step with (issue #73), and are re-exported from the package root.
 */

/**
 * Agent identity lives in `agent-catalog.ts` (issue #10) as a data row rather than an enum here
 * — the whole point of that change was that adding an agent stops being a schema edit.
 */

/**
 * Result envelope. Business logic returns this instead of throwing
 * (constitution Principle VI; plan §5).
 */
export type Ok<T> = { ok: true; data: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(data: T): Ok<T> => ({ ok: true, data });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
