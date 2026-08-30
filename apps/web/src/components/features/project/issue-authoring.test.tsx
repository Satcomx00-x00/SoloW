/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { groupLabelsByCategory } from "./issue-authoring";

/**
 * The label grouping the create dialog and the edit drawer share (user request 2026-08-30):
 * five known scoped families become headed groups in a fixed order, everything else shares one
 * flat list. Pure, so it is tested here rather than through either surface's popover.
 */

const label = (name: string) => ({ name, color: null, description: null });

describe("groupLabelsByCategory", () => {
  it("splits the five known families into headed groups, in the fixed order", () => {
    const groups = groupLabelsByCategory([
      label("type/feat"),
      label("status::todo"),
      label("area/backend"),
      label("size/xl"),
      label("prio/p0"),
    ]);
    // Order is Area · Priority · Size · Status · Type regardless of input order.
    expect(groups.map((g) => g.heading)).toEqual(["Area", "Priority", "Size", "Status", "Type"]);
  });

  it("treats prio and priority as the same family, and lowercases the prefix match", () => {
    const groups = groupLabelsByCategory([label("Priority::high"), label("prio/p1")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBe("Priority");
    expect(groups[0]?.items.map((i) => i.short)).toEqual(["high", "p1"]);
  });

  it("puts everything unrecognised in one unheaded group after the known families", () => {
    const groups = groupLabelsByCategory([
      label("status/done"),
      label("wontfix"),
      label("needs-info"),
    ]);
    expect(groups.map((g) => g.heading)).toEqual(["Status", null]);
    const other = groups.find((g) => g.heading === null);
    // An ungrouped label keeps its whole name as the displayed value.
    expect(other?.items.map((i) => i.short)).toEqual(["wontfix", "needs-info"]);
  });

  it("keeps a plain-label repository as a single flat list — no headings at all", () => {
    const groups = groupLabelsByCategory([label("bug"), label("enhancement")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBeNull();
  });

  it("does not treat an empty prefix (`::x`, `/x`) as a category", () => {
    const groups = groupLabelsByCategory([label("::orphan"), label("/loose")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBeNull();
    expect(groups[0]?.items.map((i) => i.short)).toEqual(["::orphan", "/loose"]);
  });
});
