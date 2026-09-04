import { z } from "zod";
import { idSchema, repositorySourceSchema, timestampsSchema } from "./common.js";
import { pageInputSchema, pageOf } from "./page.js";

/**
 * Connect a Repository (spec FR-021, clarified 2026-08-17).
 * `location` is a filesystem path when source is local_path, or a URL when remote_url.
 */
export const connectRepositoryInput = z
  .object({
    name: z.string().min(1).max(120),
    source: repositorySourceSchema,
    location: z.string().min(1).max(2000),
  })
  .superRefine((val, ctx) => {
    if (val.source === "remote_url") {
      const looksLikeUrl = /^(https?|git|ssh):\/\/|^git@/.test(val.location);
      if (!looksLikeUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["location"],
          message: "remote_url location must be a git URL",
        });
      }
    }
    /*
     * The other half of the same sentence, and defence in depth rather than the defence.
     *
     * A `local_path` location reaches the orchestrator as a host path — `manager.ts` returns it
     * verbatim, `task-run.ts` bind-mounts it — and a *relative* one is completed from whatever
     * directory the orchestrator process happens to be running in. `"."` therefore named SoloW's
     * own checkout, and the Docker driver's mount guard mounted it read-write into the agent's
     * container until it learned to refuse a source that is not absolute. That guard is still
     * where this is enforced, because it is the last thing before `docker run` and it also sees
     * paths that never came through this schema; what this adds is the Owner-facing half — the
     * error arrives on the field they typed into, at the moment they typed it, rather than as a
     * container that would not start three steps later.
     *
     * `startsWith("/")` and not `node:path`: this package is imported by the browser bundle, and
     * every path this describes is a POSIX one on the orchestrator's host.
     *
     * Deliberately only on the *input* schema. `repositoryDto` still reads `location` as a plain
     * string, so a row already stored by a deployment that predates this — however odd — keeps
     * loading; the constraint applies to what is connected from now on.
     */
    if (val.source === "local_path" && !val.location.startsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["location"],
        message: "local_path location must be an absolute path",
      });
    }
  });
export type ConnectRepositoryInput = z.infer<typeof connectRepositoryInput>;

export const repositoryDto = z
  .object({
    id: idSchema,
    name: z.string(),
    source: repositorySourceSchema,
    location: z.string(),
    /** Set together, once linked to an Integration (issue #15) — null for a purely local repo. */
    integrationId: idSchema.nullable(),
    externalFullName: z.string().nullable(),
    /**
     * The Integration's own provider and host, carried alongside the repository rather than
     * looked up separately (user request 2026-08-27).
     *
     * A Workspace can hold more than one Integration for the same provider — two self-hosted
     * GitLab instances, or one self-hosted and gitlab.com — and nothing on `repository` itself
     * says which one a row came from (`integrationId` is only a foreign key). A picker choosing
     * between repositories has to be able to say "GitLab @ gitlab.example.com" rather than just
     * "GitLab" twice with no way to tell them apart. Both null for a purely local repository,
     * both set together like `integrationId` — there is no state where one is set without the
     * other.
     */
    provider: z.string().nullable(),
    integrationBaseUrl: z.string().nullable(),
    /** How many Issues this Repository currently holds — for a picker to show before it commits. */
    issueCount: z.number().int().nonnegative(),
    /** Files copied into every new worktree, as repository-relative globs (issue #52). */
    setupFilePatterns: z.array(z.string()),
  })
  .merge(timestampsSchema);
export type RepositoryDto = z.infer<typeof repositoryDto>;

/**
 * How many setup-file patterns a Repository may carry. A generous ceiling on a list that is
 * meant to name a handful of configuration files — an allowlist that needs fifty entries has
 * stopped being an allowlist.
 */
export const MAX_SETUP_FILE_PATTERNS = 20;

/**
 * One glob naming a file copied from the repository into every new worktree (issue #52).
 *
 * A fresh worktree has no `.env`, so the agent cannot run the test suite or start the dev
 * server, and spends its first turns discovering that. This is the allowlist that fixes it —
 * deliberately an allowlist, never "copy everything git-ignored", which would sweep in
 * credentials, caches and build output indiscriminately.
 *
 * The constraints are the path jail (AC-6). Patterns are repository-relative, so an absolute
 * path or a `..` segment is rejected here rather than at the point where it would read a file
 * outside the repository. A leading `:` is refused because git spells pathspec magic that way
 * and the pattern is later given to git as one; a leading `-` because a value that can look
 * like an option should never be able to, whatever future call site passes it.
 */
export const setupFilePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith("/"), { message: "pattern must be relative to the repository root" })
  .refine((p) => !p.split("/").includes(".."), { message: "pattern must not leave the repository" })
  .refine((p) => !p.startsWith(":") && !p.startsWith("-"), {
    message: "pattern must not start with : or -",
  })
  .refine((p) => ![...p].some((c) => c.charCodeAt(0) < 0x20), {
    message: "pattern must not contain a control character",
  });

export const setupFilePatternsSchema = z.array(setupFilePatternSchema).max(MAX_SETUP_FILE_PATTERNS);

/**
 * Replace a Repository's setup-file allowlist (issue #52). The whole list is sent, not a delta:
 * the UI edits it as one list, and a partial update of a security-relevant allowlist would make
 * "what is copied right now" a question about ordering rather than about the stored value.
 */
export const updateRepositorySetupInput = z.object({
  repositoryId: idSchema,
  setupFilePatterns: setupFilePatternsSchema,
});
export type UpdateRepositorySetupInput = z.infer<typeof updateRepositorySetupInput>;

/**
 * A git ref name that is safe to hand to `git` as an argument (issue #7).
 *
 * Both a Task attachment's base ref and its checkout branch reach `git worktree add … -B
 * <branch> <base>` as argv, so the same jail `setupFilePatternSchema` documents applies for the
 * same reason: a value beginning with `-` would be read as an option rather than as a ref, and
 * `baseRef` has been unvalidated beyond a length bound since it was introduced. A `..` segment
 * is refused because git spells revision ranges that way, whitespace and control characters
 * because git refuses them itself and a legible error here beats a command failure three steps
 * later.
 */
export const gitRefNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((r) => !r.startsWith("-") && !r.startsWith(":"), {
    message: "ref must not start with - or :",
  })
  .refine((r) => !r.split("/").includes(".."), { message: "ref must not contain a .. segment" })
  .refine((r) => !/[\s~^:?*[\\]/.test(r), { message: "ref must not contain git wildcard syntax" })
  .refine((r) => ![...r].some((c) => c.charCodeAt(0) < 0x20), {
    message: "ref must not contain a control character",
  });

/**
 * The Repositories a Workspace has connected, one page at a time.
 *
 * Paged like every other list for one reason: `repository.list` is an MCP tool, and #82 is the
 * issue that says a discovery tool must bound what it spends of an agent's context. A Workspace
 * rarely has a hundred repositories — but "rarely" is not a bound, and the surface that would
 * suffer is the one nobody is watching.
 */
export const listRepositoriesInput = pageInputSchema;
export type ListRepositoriesInput = z.infer<typeof listRepositoriesInput>;

export const repositoryListDto = pageOf(repositoryDto);
export type RepositoryListDto = z.infer<typeof repositoryListDto>;

/**
 * Seed a Repository's provider labels from SoloW's own default taxonomy (user request
 * 2026-08-27): `type/*`, `prio/*`, `size/*`, `status/*`, `area/*`, written straight to whichever
 * of GitHub or GitLab the Repository is linked to, so an Owner starting from an empty repository
 * is not left to type out a label vocabulary by hand.
 *
 * Additive only, the same rule `provisionProjectStructure` follows for GitLab's scoped labels: a
 * label the repository already has, under any of these prefixes or none, is left exactly as it
 * is and only reported.
 */
export const seedDefaultLabelsInput = z.object({ repositoryId: idSchema });
export type SeedDefaultLabelsInput = z.infer<typeof seedDefaultLabelsInput>;

export const seedDefaultLabelsResult = z.object({
  /** Label names this call created. */
  created: z.array(z.string()),
  /** Label names already present, left untouched. */
  existing: z.array(z.string()),
});
export type SeedDefaultLabelsResult = z.infer<typeof seedDefaultLabelsResult>;
