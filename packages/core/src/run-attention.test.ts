/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { INTERRUPTED_REASON, STRANDED_REVIEW_REASON } from "./billing.js";
import {
  attentionDueAt,
  PARK_WINDOW_MS,
  parkOverdue,
  QUIET_RUN_MS,
  RECLAIM_STALE_MS,
  type RunAttentionInput,
  runAttention,
  STRANDED_PARK_REASON,
  silentPastReclaim,
} from "./run-attention.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function row(overrides: Partial<RunAttentionInput>): RunAttentionInput {
  return {
    state: "running",
    failureReason: null,
    updatedAt: ago(QUIET_RUN_MS * 10),
    lastActivityAt: ago(0),
    sessionState: "active",
    ...overrides,
  };
}

describe("the sweep's thresholds", () => {
  it("calls a run lost at exactly the reclaim window, not a millisecond before", () => {
    expect(silentPastReclaim(NOW - RECLAIM_STALE_MS + 1, NOW)).toBe(false);
    expect(silentPastReclaim(NOW - RECLAIM_STALE_MS, NOW)).toBe(true);
  });

  it("calls a park overdue only past a whole window plus a reclaim", () => {
    expect(parkOverdue(NOW - PARK_WINDOW_MS, NOW)).toBe(false);
    expect(parkOverdue(NOW - PARK_WINDOW_MS - RECLAIM_STALE_MS, NOW)).toBe(true);
  });

  it("tells the user about a quiet run only after the sweep has had a full window to act", () => {
    expect(QUIET_RUN_MS).toBeGreaterThan(RECLAIM_STALE_MS);
  });
});

describe("runAttention", () => {
  it("lists every failed Task, whatever its reason, from when it failed", () => {
    const failedAt = ago(60_000);
    for (const reason of [null, "fail", INTERRUPTED_REASON]) {
      expect(
        runAttention(row({ state: "failed", failureReason: reason, updatedAt: failedAt }), NOW),
      ).toEqual({ kind: "failed", cause: "failed", since: failedAt });
    }
  });

  it("leaves alone a Task waiting at the gate for a person", () => {
    expect(runAttention(row({ state: "review", sessionState: "awaiting_review" }), NOW)).toBeNull();
  });

  it("flags a review decision that was recorded and never applied", () => {
    const at = ago(5 * 60_000);
    expect(
      runAttention(
        row({ state: "review", failureReason: STRANDED_REVIEW_REASON, updatedAt: at }),
        NOW,
      ),
    ).toEqual({ kind: "stuck", cause: "decision_not_applied", since: at });
  });

  it("does not flag a running Task that spoke inside the quiet window", () => {
    const input = row({ lastActivityAt: ago(QUIET_RUN_MS - 1), updatedAt: ago(QUIET_RUN_MS * 3) });
    expect(runAttention(input, NOW)).toBeNull();
  });

  it("flags a running Task silent for the whole quiet window, from its last word", () => {
    const last = ago(QUIET_RUN_MS);
    expect(runAttention(row({ lastActivityAt: last }), NOW)).toEqual({
      kind: "stuck",
      cause: "run_silent",
      since: last,
    });
  });

  it("counts a recent write to the Task row as life — a relaunch touches the row", () => {
    const input = row({ lastActivityAt: ago(QUIET_RUN_MS * 2), updatedAt: ago(60_000) });
    expect(runAttention(input, NOW)).toBeNull();
  });

  it("does not flag a finished run whose Task still reads running", () => {
    const input = row({ lastActivityAt: ago(QUIET_RUN_MS * 5), sessionState: "awaiting_review" });
    expect(runAttention(input, NOW)).toBeNull();
  });

  it("flags a parked Task the sweep stamped as never resumed", () => {
    const last = ago(PARK_WINDOW_MS * 2);
    expect(
      runAttention(
        row({ state: "parked", failureReason: STRANDED_PARK_REASON, lastActivityAt: last }),
        NOW,
      ),
    ).toEqual({ kind: "stuck", cause: "park_never_resumed", since: last });
  });

  it("leaves a parked Task alone while it is still inside its sleep", () => {
    const input = row({ state: "parked", lastActivityAt: ago(PARK_WINDOW_MS) });
    expect(runAttention(input, NOW)).toBeNull();
  });

  it("flags a parked Task past its wake-up even before any sweep stamped it", () => {
    const last = ago(PARK_WINDOW_MS + RECLAIM_STALE_MS);
    const input = row({ state: "parked", lastActivityAt: last, updatedAt: last });
    expect(runAttention(input, NOW)).toEqual({
      kind: "stuck",
      cause: "park_overdue",
      since: last,
    });
  });

  it("never flags backlog, ready or done", () => {
    for (const state of ["backlog", "ready", "done"] as const) {
      expect(runAttention(row({ state, lastActivityAt: ago(PARK_WINDOW_MS * 9) }), NOW)).toBeNull();
    }
  });
});

describe("attentionDueAt", () => {
  it("is the moment a running Task's quiet window ends", () => {
    const last = ago(60_000);
    expect(attentionDueAt(row({ lastActivityAt: last }))).toBe(Date.parse(last) + QUIET_RUN_MS);
  });

  it("is the moment a parked Task's wake-up becomes overdue", () => {
    const last = ago(60_000);
    expect(attentionDueAt(row({ state: "parked", lastActivityAt: last }))).toBe(
      Date.parse(last) + PARK_WINDOW_MS + RECLAIM_STALE_MS,
    );
  });

  it("is null where the clock alone never changes the answer", () => {
    expect(attentionDueAt(row({ state: "failed" }))).toBeNull();
    expect(attentionDueAt(row({ state: "review" }))).toBeNull();
    expect(attentionDueAt(row({ sessionState: "awaiting_review" }))).toBeNull();
    expect(
      attentionDueAt(row({ state: "parked", failureReason: STRANDED_PARK_REASON })),
    ).toBeNull();
  });

  it("agrees with runAttention at the moment it names", () => {
    const input = row({ lastActivityAt: ago(60_000) });
    const due = attentionDueAt(input) ?? 0;
    expect(runAttention(input, due - 1)).toBeNull();
    expect(runAttention(input, due)?.cause).toBe("run_silent");
  });
});
