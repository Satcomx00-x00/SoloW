import "server-only";
import { router } from "../trpc.js";
import { integrationRouter } from "./integration.js";
import { issueRouter } from "./issue.js";
import { profileRouter } from "./profile.js";
import { repositoryRouter } from "./repository.js";
import { reviewRouter } from "./review.js";
import { secretRouter } from "./secret.js";
import { sessionRouter } from "./session.js";
import { streamRouter } from "./stream.js";
import { taskRouter } from "./task.js";

/** The core-program API surface (Decision 0011). openapi.json is generated from this. */
export const appRouter = router({
  issue: issueRouter,
  integration: integrationRouter,
  task: taskRouter,
  profile: profileRouter,
  repository: repositoryRouter,
  review: reviewRouter,
  secret: secretRouter,
  session: sessionRouter,
  stream: streamRouter,
});

export type AppRouter = typeof appRouter;
