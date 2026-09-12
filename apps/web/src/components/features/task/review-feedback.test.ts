import { describe, expect, it } from "bun:test";
import type { DecisionWidget, ReviewNote } from "@solow/contracts";
import {
  collateDecisions,
  collateFeedback,
  FEEDBACK_MAX,
  joinFeedback,
  noteAnchor,
} from "./review-feedback";

/**
 * The draft as the one string the harness reads (F10 FR-7). The properties a harness depends on:
 * anchors it can act on, an order it can work through, and nothing invented when there is
 * nothing to say.
 */

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  repositoryId: "repo-1",
  path: "src/a.ts",
  side: "new",
  line: 12,
  text: "rename this",
  ...over,
});

describe("collateFeedback", () => {
  it("is undefined when the reviewer said nothing, so the decision goes out as before", () => {
    expect(collateFeedback({ notes: [], general: "" })).toBeUndefined();
    expect(collateFeedback({ notes: [], general: "   " })).toBeUndefined();
  });

  it("puts the general remark first and the line notes after, by file and line", () => {
    const text = collateFeedback({
      general: "Close, but the config handling is wrong.",
      notes: [
        note({ path: "src/b.ts", line: 3, text: "second" }),
        note({ path: "src/a.ts", line: 40, text: "later" }),
        note({ path: "src/a.ts", line: 12, text: "earlier" }),
      ],
    });
    expect(text).toBe(
      [
        "Close, but the config handling is wrong.",
        "",
        "Notes on specific lines:",
        "- src/a.ts:12 — earlier",
        "- src/a.ts:40 — later",
        "- src/b.ts:3 — second",
      ].join("\n"),
    );
  });

  it("marks an old-side line, and names the repository only when more than one is noted", () => {
    expect(noteAnchor({ path: "src/a.ts", side: "old", line: 7 })).toBe("src/a.ts:7 (old)");
    const names = (id: string | null) => (id === "repo-2" ? "shared-lib" : "api");
    const one = collateFeedback({ general: "", notes: [note({})] }, names);
    expect(one).toContain("- src/a.ts:12 —");
    const two = collateFeedback(
      { general: "", notes: [note({}), note({ repositoryId: "repo-2", path: "src/lib.ts" })] },
      names,
    );
    expect(two).toContain("- (api) src/a.ts:12 —");
    expect(two).toContain("- (shared-lib) src/lib.ts:12 —");
  });

  it("cuts at the contract's ceiling rather than refusing the decision", () => {
    const text = collateFeedback({ general: "x".repeat(FEEDBACK_MAX + 500), notes: [] });
    expect(text?.length).toBeLessThanOrEqual(FEEDBACK_MAX);
    expect(text?.endsWith("[feedback truncated at the limit]")).toBe(true);
  });
});

/**
 * The reviewer's decisions (review analysis, point 3), as the next Step's harness reads them:
 * which way each went and — the fact that matters most — whether the harness was overturned.
 */
const DECISION: DecisionWidget = {
  kind: "decision",
  id: "include-semantics",
  question: "What does include select?",
  options: [
    { id: "all", label: "Every nested row" },
    { id: "matching", label: "Only matching rows" },
  ],
  chosen: "matching",
};

describe("collateDecisions", () => {
  it("is undefined when nothing was settled", () => {
    expect(collateDecisions([DECISION], [])).toBeUndefined();
    expect(collateDecisions([], [{ id: "x", choice: "y" }])).toBeUndefined();
  });

  it("says when the reviewer confirmed the harness, in the harness's own words", () => {
    expect(collateDecisions([DECISION], [{ id: DECISION.id, choice: "matching" }])).toBe(
      "Decisions settled by the reviewer:\n- What does include select? → Only matching rows (confirmed your choice)",
    );
  });

  it("names the choice that was overturned, so the next step cannot read it as a nuance", () => {
    expect(collateDecisions([DECISION], [{ id: DECISION.id, choice: "all" }])).toBe(
      'Decisions settled by the reviewer:\n- What does include select? → Every nested row (overturned your choice of "Only matching rows")',
    );
  });

  it("carries the reviewer's own words when neither option was taken", () => {
    const text = collateDecisions(
      [DECISION],
      [{ id: DECISION.id, choice: "other", note: "  Every row, but paginated.  " }],
    );
    expect(text).toContain("→ Every row, but paginated. (overturned");
  });
});

describe("joinFeedback", () => {
  it("joins what there is and is undefined when there is nothing", () => {
    expect(joinFeedback(undefined, undefined)).toBeUndefined();
    expect(joinFeedback("notes", undefined, "decisions")).toBe("notes\n\ndecisions");
  });

  it("keeps the whole to the contract's ceiling", () => {
    const text = joinFeedback("x".repeat(FEEDBACK_MAX), "decisions") ?? "";
    expect(text.length).toBeLessThanOrEqual(FEEDBACK_MAX);
    expect(text.endsWith("[feedback truncated at the limit]")).toBe(true);
  });
});
