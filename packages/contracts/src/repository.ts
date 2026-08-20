import { z } from "zod";
import { idSchema, repositorySourceSchema, timestampsSchema } from "./common.js";

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
