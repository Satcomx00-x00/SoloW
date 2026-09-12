import "server-only";

/**
 * The cascade moved into `@solow/db` (`task-cascade.ts` there) so the orchestrator's retention
 * sweep and the web app's `deleteIssue` share one walk. Re-exported so the DAL keeps its seam.
 */
export { cascadeDeleteTasks } from "@solow/db";
