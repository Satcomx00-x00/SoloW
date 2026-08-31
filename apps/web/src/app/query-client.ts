import { QueryClient } from "@tanstack/react-query";

/**
 * How long a read stays good, and why the app used to feel like it was always loading.
 *
 * The client was built as `new QueryClient()`, whose default `staleTime` is **0** — every query
 * is stale the instant it resolves. So every mount refetched, and because this is a SPA where
 * each route mounts its own components, every navigation was a spinner over data the browser was
 * already holding. Going to a Task and back re-read the board; opening a dialog re-read the same
 * four lists it read the last time it opened.
 *
 * Thirty seconds is not a guess about how fast a Workspace changes, because nothing here depends
 * on it being right:
 *
 *  - **A write is never waited out.** All 110 mutation call sites invalidate the queries they
 *    affect, and invalidation refetches regardless of staleness. Creating a Task shows it
 *    immediately, exactly as before.
 *  - **A live change is never waited out either.** Task and session state arrive on the stream
 *    (`use-task-stream`), whose handlers invalidate on each event.
 *
 * What the window actually governs is the third case: a read nobody has invalidated, on a screen
 * being revisited. Before, that cost a round trip and a spinner. Now it repaints from cache and
 * revalidates only once the window has passed.
 *
 * `refetchOnWindowFocus` is deliberately left at React Query's default of `true`. It is
 * frequently the first thing switched off in a change like this, and it should not be: with a
 * non-zero `staleTime` it no longer refires everything on every tab switch — it refetches only
 * what has actually gone stale, which is the behaviour that was wanted all along. Disabling it
 * would trade the jank for a tab that sits on an hour-old board.
 */
const STALE_TIME_MS = 30_000;

/**
 * How long an unused answer is kept after the last component reading it unmounts.
 *
 * React Query's default is five minutes, which is short for the journey this app is built
 * around: an operator opens a Task, watches an agent work, reviews a diff and goes back. Fifteen
 * minutes covers that round trip, so returning to the board repaints instead of reloading.
 *
 * The cost is bounded and small — DTOs for a Workspace's issues, tasks and profiles — and it is
 * paid only for queries that actually ran.
 */
const GC_TIME_MS = 15 * 60_000;

/**
 * Whether to try again, and the reason the default answer was wrong here.
 *
 * React Query retries a failed query three times with backoff. Against this API that is close to
 * the worst possible policy: every procedure re-checks the session and the Workspace, so
 * `UNAUTHORIZED`, `FORBIDDEN` and `NOT_FOUND` are *settled answers* — retrying one cannot change
 * it, and the operator waits through three round trips and ~7 s of backoff to be told something
 * the first response already said.
 *
 * So a refusal surfaces at once, and only a transient failure — a dropped connection, a 5xx — is
 * retried, once. Matched on the HTTP status tRPC puts on the error, and defaulting to *retry*
 * when the shape is unrecognised: an error this cannot classify is more likely a transport
 * failure than a considered refusal, and one extra request is the cheaper mistake.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  const status = (error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;
  if (typeof status !== "number") return true;
  return status >= 500;
}

/**
 * The one place the client's caching policy is stated.
 *
 * A function rather than a literal at the provider, so the policy can be asserted directly —
 * these are the numbers that decide whether the app feels instant, and a regression to
 * `new QueryClient()` is invisible in review and obvious to a user.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        gcTime: GC_TIME_MS,
        retry: shouldRetry,
      },
      // A mutation is not idempotent. Re-sending "create this Task" because the response was slow
      // is how an operator ends up with two, so a failed write is reported, never repeated.
      mutations: { retry: false },
    },
  });
}
