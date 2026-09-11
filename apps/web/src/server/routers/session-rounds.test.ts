/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ReviewDto } from "@solow/contracts";
import { sessionRounds } from "./session-rounds.js";

/**
 * Review rounds read back out of one Session's log (F10 FR-7). The rules pinned here are the
 * ones a reviewer would notice being wrong: a round's change is what stood at *its* gate, not
 * the latest; decisions pair to rounds in order; the open tail is a round only when something
 * new was captured since the last exit.
 */

const capture = (seq: number, repositoryId: string, path: string) => ({
  seq,
  kind: "diff",
  payload: {
    diffRef: `branch/${repositoryId}`,
    repositoryId,
    repositoryName: repositoryId,
    files: [{ path, status: "modified", additions: 1, deletions: 0 }],
    patch: `--- a/${path}\n+++ b/${path}\n`,
    truncated: false,
  },
});
const exit = (seq: number, to: string) => ({
  seq,
  kind: "state",
  payload: { kind: "state", from: "review", to },
});
const text = (seq: number) => ({
  seq,
  kind: "assistant_turn",
  payload: { kind: "assistant_turn", text: "…", thinking: false },
});
const review = (
  id: string,
  decision: ReviewDto["decision"],
  feedback: string | null,
): ReviewDto => ({
  id,
  sessionId: "s",
  decision,
  feedback,
  actorUserId: "u",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("sessionRounds", () => {
  it("closes a round on each exit from review, with the change as it stood then", () => {
    const rounds = sessionRounds(
      [
        text(0),
        capture(1, "api", "src/v1.ts"),
        exit(2, "running"),
        text(3),
        capture(4, "api", "src/v2.ts"),
        exit(5, "done"),
      ],
      [review("r1", "request_changes", "not like that"), review("r2", "approve", null)],
      ["api"],
    );

    expect(rounds.map((r) => r.index)).toEqual([1, 2]);
    expect(rounds.map((r) => r.closedAtSeq)).toEqual([2, 5]);
    expect(rounds.map((r) => r.diffs[0]?.files[0]?.path)).toEqual(["src/v1.ts", "src/v2.ts"]);
    expect(rounds.map((r) => r.review?.decision)).toEqual(["request_changes", "approve"]);
    expect(rounds[0]?.review?.feedback).toBe("not like that");
  });

  it("adds the open tail as a round only when something was captured since the last exit", () => {
    const closedOnly = sessionRounds(
      [capture(0, "api", "src/v1.ts"), exit(1, "running"), text(2)],
      [review("r1", "request_changes", null)],
      ["api"],
    );
    expect(closedOnly).toHaveLength(1);

    const withTail = sessionRounds(
      [capture(0, "api", "src/v1.ts"), exit(1, "running"), capture(2, "api", "src/v2.ts")],
      [review("r1", "request_changes", null)],
      ["api"],
    );
    expect(withTail).toHaveLength(2);
    expect(withTail[1]).toMatchObject({ index: 2, closedAtSeq: null, review: null });
    expect(withTail[1]?.diffs[0]?.files[0]?.path).toBe("src/v2.ts");
  });

  it("is one open round for a Session at its first gate, and none before any capture", () => {
    expect(sessionRounds([text(0)], [], ["api"])).toEqual([]);
    const first = sessionRounds([capture(0, "api", "src/v1.ts")], [], ["api"]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ index: 1, closedAtSeq: null, review: null });
  });

  it("carries a repository the later round did not touch forward, in attachment order", () => {
    // Round 2 re-captured only `lib`; `api` still shows what it captured in round 1, because that
    // is what the reviewer of round 2 was looking at.
    const rounds = sessionRounds(
      [
        capture(0, "lib", "src/lib.ts"),
        capture(1, "api", "src/api.ts"),
        exit(2, "running"),
        capture(3, "lib", "src/lib2.ts"),
        exit(4, "done"),
      ],
      [review("r1", "request_changes", null), review("r2", "approve", null)],
      ["api", "lib"],
    );
    expect(rounds[1]?.diffs.map((d) => d.repositoryId)).toEqual(["api", "lib"]);
    expect(rounds[1]?.diffs.map((d) => d.files[0]?.path)).toEqual(["src/api.ts", "src/lib2.ts"]);
  });

  it("skips an exit with nothing captured, but still spends its decision", () => {
    // A Task moved out of Review by hand before the harness captured anything is not a round;
    // the review recorded for that exit must not be handed to the next real round.
    const rounds = sessionRounds(
      [exit(0, "ready"), capture(1, "api", "src/v1.ts"), exit(2, "done")],
      [review("r0", "reject", null), review("r1", "approve", null)],
      ["api"],
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.review?.decision).toBe("approve");
  });
});
