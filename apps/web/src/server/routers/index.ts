import "server-only";
import { router } from "../trpc.js";
import { flagRouter } from "./flag.js";
import { integrationRouter } from "./integration.js";
import { issueRouter } from "./issue.js";
import { mcpTokenRouter } from "./mcp-token.js";
import { preferenceRouter } from "./preference.js";
import { profileRouter } from "./profile.js";
import { repositoryRouter } from "./repository.js";
import { reviewRouter } from "./review.js";
import { secretRouter } from "./secret.js";
import { sessionRouter } from "./session.js";
import { streamRouter } from "./stream.js";
import { taskRouter } from "./task.js";
import { workflowRouter } from "./workflow.js";

/** The core-program API surface (Decision 0011). openapi.json is generated from this. */
export const appRouter = router({
  flag: flagRouter,
  issue: issueRouter,
  integration: integrationRouter,
  mcpToken: mcpTokenRouter,
  preference: preferenceRouter,
  task: taskRouter,
  profile: profileRouter,
  repository: repositoryRouter,
  review: reviewRouter,
  secret: secretRouter,
  session: sessionRouter,
  stream: streamRouter,
  workflow: workflowRouter,
});

export type AppRouter = typeof appRouter;
