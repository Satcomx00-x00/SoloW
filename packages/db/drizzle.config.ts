import { defineConfig } from "drizzle-kit";

/**
 * SQLite (local) migration config. Generated migrations only — no handwritten SQL
 * (constitution Principle VI / task TASK-004).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.GATECONTROL_SQLITE_PATH ?? ".gatecontrol/gatecontrol.db",
  },
});
