import { z } from "zod";

/**
 * Validated environment module (constitution Security constraint).
 * Nothing outside this module reads process.env for DB/secret configuration.
 */
const dbEnvSchema = z.object({
  /** Which store backs the single data model (Decision 0008). v1 ships SQLite. */
  SOLOW_DB_DRIVER: z.enum(["sqlite", "postgres"]).default("sqlite"),
  /** SQLite file path (local). */
  SOLOW_SQLITE_PATH: z.string().min(1).default(".solow/solow.db"),
  /** Postgres connection string (hosted). */
  SOLOW_DATABASE_URL: z.string().url().optional(),
  /** 32-byte key (base64) for secret encryption at rest. */
  SOLOW_SECRET_KEY: z.string().min(1),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

let cached: DbEnv | undefined;

export function dbEnv(): DbEnv {
  if (cached) return cached;
  cached = dbEnvSchema.parse(process.env);
  return cached;
}
