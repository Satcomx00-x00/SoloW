import { describe, expect, it } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { createQueryClient } from "./query-client";

/**
 * The caching policy, asserted rather than described.
 *
 * These numbers are what decide whether a revisited screen repaints or reloads, and the failure
 * they guard against is silent: reverting to `new QueryClient()` reads as a simplification in a
 * diff and shows up only as an app that spins on every navigation. Nothing else in the suite
 * would notice, because every component test brings its own client (`src/test/trpc-harness`).
 */

function defaults() {
  return createQueryClient().getDefaultOptions();
}

/** A tRPC client error carrying the HTTP status the retry policy reads. */
function trpcError(httpStatus: number): TRPCClientError<never> {
  const error = new TRPCClientError<never>("refused");
  Object.assign(error, { data: { httpStatus } });
  return error;
}

describe("query defaults", () => {
  it("keeps a read good long enough that going back does not reload it", () => {
    // The whole point: not zero. Zero is React Query's default and is what made every mount
    // refetch data the browser was already holding.
    expect(defaults().queries?.staleTime).toBe(30_000);
  });

  it("holds an unused answer past the length of a review round trip", () => {
    expect(defaults().queries?.gcTime).toBe(15 * 60_000);
  });

  it("leaves refetch-on-focus alone, so staleness decides it rather than a flag", () => {
    // Unset, i.e. React Query's `true`. With a non-zero staleTime it refetches only what has
    // gone stale — disabling it would trade the jank for an hour-old board on a tab switch.
    expect(defaults().queries?.refetchOnWindowFocus).toBeUndefined();
  });
});

describe("retrying", () => {
  const retry = () => {
    const policy = defaults().queries?.retry;
    if (typeof policy !== "function") throw new Error("retry policy is not a function");
    return policy;
  };

  it("does not retry a refusal — the answer cannot change", () => {
    // Every procedure re-checks the session and the Workspace, so these are settled answers.
    // Retrying makes the operator wait through three round trips to be told the same thing.
    for (const status of [400, 401, 403, 404, 409, 429]) {
      expect(retry()(0, trpcError(status))).toBe(false);
    }
  });

  it("retries a server failure exactly once", () => {
    expect(retry()(0, trpcError(500))).toBe(true);
    expect(retry()(1, trpcError(500))).toBe(false);
  });

  it("retries an error it cannot classify", () => {
    // A dropped connection carries no HTTP status. One extra request is the cheaper mistake.
    expect(retry()(0, new Error("network error"))).toBe(true);
    // React Query types the argument as `Error`; at runtime a failure can arrive as anything,
    // and the policy has to answer for that rather than throw reading `.data` off it.
    expect(retry()(0, null as unknown as Error)).toBe(true);
  });
});

describe("mutations", () => {
  it("never repeats a write", () => {
    // Re-sending "create this Task" because the response was slow is how an operator ends up
    // with two of them.
    expect(defaults().mutations?.retry).toBe(false);
  });
});
