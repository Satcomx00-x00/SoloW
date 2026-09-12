import { describe, expect, it } from "bun:test";
import {
  buildReviewBrief,
  checkKindOf,
  criterionOfClaim,
  cwdOf,
  parseAcceptanceCriteria,
  verdictOf,
} from "./review-brief.js";

/** Pinned on the Issue and the log of the Task the analysis was written about (#115). */
describe("parseAcceptanceCriteria", () => {
  it("reads the numbered checkbox form, ticked or not", () => {
    const rows = parseAcceptanceCriteria(
      [
        "## Acceptance criteria",
        "- [ ] **AC-1** A `sector_source_overrides` table exists.",
        "- [x] **AC-2** Both foreign keys cascade on delete.",
        "- [ ] **AC-10** SDL fields carry `@selfOnly`.",
        "Some prose that is not a criterion.",
      ].join("\n"),
    );
    expect(rows.map((r) => [r.id, r.ticked])).toEqual([
      ["AC-1", false],
      ["AC-2", true],
      ["AC-10", false],
    ]);
    expect(rows[0]?.text).toBe("A `sector_source_overrides` table exists.");
  });

  it("numbers plain task-list lines when the Issue did not, and finds none in prose", () => {
    expect(parseAcceptanceCriteria("- [ ] first\n- [ ] second").map((r) => r.id)).toEqual([
      "AC-1",
      "AC-2",
    ]);
    expect(parseAcceptanceCriteria("Just a paragraph.")).toEqual([]);
    expect(parseAcceptanceCriteria(null)).toEqual([]);
  });
});

describe("claims and checks", () => {
  it("ties a step_card item to its criterion by id or by label", () => {
    expect(criterionOfClaim({ id: "ac4", label: "exclude removes the source" })).toBe("AC-4");
    expect(criterionOfClaim({ id: "migrate", label: "AC-14 integration test RUNS in CI" })).toBe(
      "AC-14",
    );
    expect(criterionOfClaim({ id: "dod", label: "typecheck / lint / test" })).toBeNull();
  });

  it("knows a verification from a read, and where it ran", () => {
    expect(
      checkKindOf('cd "$(git rev-parse --show-toplevel)" && bun run typecheck 2>&1 | tail -40'),
    ).toBe("typecheck");
    expect(checkKindOf("cd /tmp/base-115/apps/api && bun test 2>&1 | tail -8")).toBe("test");
    expect(checkKindOf("bunx @biomejs/biome check --write apps/api/src")).toBe("lint");
    expect(
      checkKindOf("sed -n 100,175p apps/api/test/graphql/sector-feed-surface.test.ts"),
    ).toBeNull();
    expect(cwdOf("cd /tmp/base-115/apps/api && bun test")).toBe("/tmp/base-115/apps/api");
    expect(cwdOf("bun test")).toBeNull();
  });

  it("reads a verdict out of the output, and says when it cannot", () => {
    expect(verdictOf(" 811 pass\n 6 fail\nRan 817 tests", true)).toEqual({
      verdict: "811 pass / 6 fail",
      passed: false,
    });
    expect(verdictOf("Checked 671 files in 1s. No fixes applied.", true)).toEqual({
      verdict: "clean",
      passed: true,
    });
    expect(verdictOf("src/x.ts(3,1): error TS2304: Cannot find name", false)).toEqual({
      verdict: "errors",
      passed: false,
    });
    expect(verdictOf("", true)).toEqual({ verdict: "ran", passed: null });
    expect(verdictOf("", false)).toEqual({ verdict: "failed", passed: false });
  });
});

describe("buildReviewBrief", () => {
  it("lines the ask, the claim and the evidence up per criterion", () => {
    const brief = buildReviewBrief({
      description: "- [ ] **AC-1** table exists\n- [ ] **AC-14** integration test runs in CI",
      steps: [
        {
          id: "ac1",
          label: "AC-1 table",
          state: "done",
          note: "packages/db/drizzle/0044_fluffy_spyke.sql",
        },
        {
          id: "ac14",
          label: "AC-14 integration test",
          state: "done",
          note: "14 cases in apps/api/test/sectors/source-overrides.test.ts; NOT executed here",
        },
        { id: "dod", label: "typecheck / lint / test", state: "done" },
      ],
      files: [
        "packages/db/drizzle/0044_fluffy_spyke.sql",
        "apps/api/test/sectors/source-overrides.test.ts",
        "packages/db/src/schema/sectors.ts",
      ],
      checks: [],
    });
    expect(brief.criteria.map((c) => [c.id, c.claim?.state ?? null, c.files, c.tests])).toEqual([
      ["AC-1", "done", ["packages/db/drizzle/0044_fluffy_spyke.sql"], []],
      [
        "AC-14",
        "done",
        ["apps/api/test/sectors/source-overrides.test.ts"],
        ["apps/api/test/sectors/source-overrides.test.ts"],
      ],
    ]);
    expect(brief.unmatched.map((c) => c.label)).toEqual(["typecheck / lint / test"]);
  });
});
