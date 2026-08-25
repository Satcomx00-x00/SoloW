import { z } from "zod";
import { taskStateSchema } from "./common.js";

/**
 * Source-control contracts (spec F22, Decision 0017).
 *
 * The panel is VS Code's, deliberately, down to the group names — a reviewer who has staged a
 * file anywhere already knows this surface. What differs is what staging *means*: it is the
 * review selection, and approval commits exactly what is staged (F22 FR-7). There is no commit
 * operation in this file, and that absence is the design.
 */

/**
 * A path a client asked to act on.
 *
 * Relative, forward-slashed, and free of `..` — checked here so a malformed request is refused
 * by the contract rather than by the code that builds an argument vector. This is *not* the
 * containment guarantee: the orchestrator still resolves the path and verifies it lies inside
 * the worktree root before git sees it (F22 NFR-3), because a symlink defeats every syntactic
 * check ever written. Two guards, and only the second one is load-bearing.
 */
export const scmPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith("/") && !/^[a-zA-Z]:/.test(p), "path must be relative")
  .refine((p) => !p.split("/").includes(".."), "path must not traverse upward")
  .refine((p) => !p.includes("\0"), "path must not contain a NUL");

/**
 * Which list a file appears in — the four headings VS Code shows, and nothing else.
 *
 * `merge` first because a conflict is the one state where nothing else in the panel is safe to
 * act on. A file can legitimately be in two groups at once (staged, then modified again); the
 * status read returns it twice, once per group, exactly as git reports it and as an editor
 * draws it.
 */
export const scmGroupSchema = z.enum(["merge", "staged", "changes", "untracked"]);
export type ScmGroup = z.infer<typeof scmGroupSchema>;

/** What happened to the file, in the vocabulary the rest of the product already uses. */
export const scmChangeKindSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "type_changed",
]);
export type ScmChangeKind = z.infer<typeof scmChangeKindSchema>;

export const scmFileDto = z.object({
  /** Repository-relative, forward-slashed. */
  path: scmPathSchema,
  /** Where a rename came from. Absent for every other kind. */
  originalPath: scmPathSchema.optional(),
  group: scmGroupSchema,
  kind: scmChangeKindSchema,
  /**
   * The single character the row shows — `M` `A` `D` `R` `C` `U` `?`.
   *
   * Carried rather than derived on the client, because the letter git prints and the kind this
   * product names are two vocabularies and only one of them is git's. A client rendering its
   * own letter from `kind` would quietly disagree with `git status` at the edges.
   */
  letter: z.string().length(1),
  /** Null for an untracked or binary file, where a line count is not a fact. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});
export type ScmFileDto = z.infer<typeof scmFileDto>;

/** Where the worktree's HEAD is, and how it stands against its upstream (F22 FR-12). */
export const scmBranchDto = z.object({
  /** Null when HEAD is detached — named as detached rather than mislabelled as a branch. */
  name: z.string().nullable(),
  detached: z.boolean(),
  /** Short HEAD sha, or null in a repository with no commits yet. */
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
});
export type ScmBranchDto = z.infer<typeof scmBranchDto>;

/**
 * One `(repository, branch)` worktree's source control (F22 FR-16).
 *
 * A Task spanning two Repositories has two of these, and a reviewer shown one merged list could
 * not tell which repository a path came from — the same reasoning that put `repositoryId` on the
 * captured diff.
 */
export const scmWorktreeDto = z.object({
  /** The `task_repository` row this worktree belongs to — the key #7 and #57 made composite. */
  attachmentId: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  branch: scmBranchDto,
  files: z.array(scmFileDto),
  /** How many entries git reported, before any bound was applied. */
  total: z.number().int().nonnegative(),
  /** True when `files` was cut short (F22 NFR-2). Never silently. */
  truncated: z.boolean(),
  /**
   * Whether the panel may write here, and why not when it may not (F22, States & rules).
   *
   * Decided on the server: a browser that decides for itself whether an agent is running would
   * be deciding it from data that is at best one turn stale, and the cost of getting it wrong is
   * a stage racing the process still writing the file.
   */
  writable: z.boolean(),
  readOnlyReason: z.string().nullable(),
});
export type ScmWorktreeDto = z.infer<typeof scmWorktreeDto>;

export const scmStatusDto = z.object({
  taskId: z.string(),
  worktrees: z.array(scmWorktreeDto),
});
export type ScmStatusDto = z.infer<typeof scmStatusDto>;

/**
 * What the orchestrator's worktree route accepts (Decision 0017).
 *
 * A closed union of named operations, not a command to run. Nothing a client sends reaches an
 * argument vector without passing through here first, and there is no member that writes to a
 * remote or creates a commit — those belong to the review gate and to issue #71.
 */
export const scmOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }),
  z.object({ op: z.literal("stage"), paths: z.array(scmPathSchema).min(1).max(1000) }),
  z.object({ op: z.literal("unstage"), paths: z.array(scmPathSchema).min(1).max(1000) }),
  z.object({ op: z.literal("discard"), paths: z.array(scmPathSchema).min(1).max(1000) }),
]);
export type ScmOperation = z.infer<typeof scmOperationSchema>;

/**
 * The request body of `POST /worktree/git`.
 *
 * There is no `workspaceId` here and there never will be: the Workspace is read from the signed
 * ticket's claims, so a caller cannot name a tenant (Principle V, F22 AC-10). `taskId` comes
 * from the claims for the same reason. What is left is which worktree, and what to do.
 */
export const worktreeGitRequest = z.object({
  ticket: z.string().min(1),
  /** Which worktree to act on. Null means every worktree of the Task, and only `status` allows it. */
  attachmentId: z.string().min(1).nullable(),
  operation: scmOperationSchema,
});
export type WorktreeGitRequest = z.infer<typeof worktreeGitRequest>;

/**
 * Every operation answers with the freshly re-read status (F22, Edge cases).
 *
 * Not an acknowledgement: a panel that rendered its own optimistic idea of what staging did
 * would drift from git the first time git disagreed — a path that vanished under it, a file
 * that was already staged. One shape for every reply means the client has exactly one way to
 * update, and it is always from what git just said.
 */
export const worktreeGitResponse = z.object({ status: scmStatusDto });
export type WorktreeGitResponse = z.infer<typeof worktreeGitResponse>;

/**
 * The body of the orchestrator's `POST /announce` — a state change made by the API, told to
 * every client watching.
 *
 * No `workspaceId` and no `taskId`: both come from the ticket's signed claims, for the reason
 * `worktreeGitRequest` gives — a caller must not be able to name a tenant (Principle V).
 */
export const announceRequest = z.object({
  ticket: z.string().min(1),
  state: taskStateSchema,
});
export type AnnounceRequest = z.infer<typeof announceRequest>;
