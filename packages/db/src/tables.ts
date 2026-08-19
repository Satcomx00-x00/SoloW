import { authSchema } from "./auth-schema.js";
import { schema as domainSchema } from "./schema.js";

/**
 * Every table in the database: the domain tables plus BetterAuth's. This is what the Drizzle
 * client is built with; `schema.ts` and `auth-schema.ts` stay separate files because drizzle-kit
 * loads each one standalone when generating migrations.
 */
export const allTables = { ...domainSchema, ...authSchema };
