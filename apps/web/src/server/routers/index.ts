import "server-only";
import { router } from "../trpc.js";
import { issueRouter } from "./issue.js";
import { taskRouter } from "./task.js";
import { profileRouter } from "./profile.js";
import { repositoryRouter } from "./repository.js";
import { reviewRouter } from "./review.js";
import { secretRouter } from "./secret.js";

/** The core-program API surface (Decision 0011). openapi.json is generated from this. */
export const appRouter = router({
  issue: issueRouter,
  task: taskRouter,
  profile: profileRouter,
  repository: repositoryRouter,
  review: reviewRouter,
  secret: secretRouter,
});

export type AppRouter = typeof appRouter;
