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
  })
  .merge(timestampsSchema);
export type RepositoryDto = z.infer<typeof repositoryDto>;
