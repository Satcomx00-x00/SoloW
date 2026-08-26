/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { ProjectFieldDto, ProjectItemDto } from "@gatecontrol/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ProjectRoadmap, pickRoadmapDateFields, planRoadmap } from "./project-roadmap";
import type { ProjectRow } from "./project-table";

/**
 * The roadmap layout (issue #129, F23 FR-10 and AC-4).
 *
 * One claim is asserted from three directions, because it is the claim a roadmap is usually
 * wrong about: **no item is ever dropped.** Full dates draw a bar, one date draws a point, and
 * no dates at all is listed beside the timeline — "not scheduled" being the answer a roadmap is
 * most often asked for.
 */

afterEach(cleanup);

const field = (over: Partial<ProjectFieldDto> & Pick<ProjectFieldDto, "id">): ProjectFieldDto => ({
  providerFieldId: `p-${over.id}`,
  name: "Start date",
  type: "date",
  options: [],
  iterations: [],
  position: 0,
  readOnly: false,
  readOnlyReason: null,
  ...over,
});

const start = field({ id: "f-start", name: "Start date" });
const target = field({ id: "f-target", name: "Target date", position: 1 });

const row = (id: string, title: string, values: ProjectItemDto["values"] = {}): ProjectRow => ({
  item: {
    id,
    providerItemId: `i-${id}`,
    issueId: `iss-${id}`,
    position: 0,
    archivedAt: null,
    values,
    issueExternalId: `ext-${id}`,
    parentExternalId: null,
    repositoryId: null,
    closed: false,
  },
  title,
  issueNumber: 7,
  issueUrl: null,
  linkedChangeRequests: [],
  labels: [],
});

const scheduled = row("r1", "Ship the mirror", {
  "f-start": { type: "date", date: "2026-09-01" },
  "f-target": { type: "date", date: "2026-10-15" },
});
const partial = row("r2", "Half a plan", { "f-start": { type: "date", date: "2026-09-20" } });
const undated = row("r3", "Nobody has said when");

describe("pickRoadmapDateFields", () => {
  it("finds the two ends by name, never by which provider this is", () => {
    // Decision 0016: a branch on a provider id is what the registry exists to prevent, and the
    // date columns are a convention on both hosts rather than a fact about either.
    expect(pickRoadmapDateFields([target, start])).toEqual({ start, target });
  });

  it("falls back to the project's own field order when nobody used the word", () => {
    // A guess, and a visible one — better than a timeline that refuses to draw.
    const a = field({ id: "f-a", name: "Kickoff" });
    const b = field({ id: "f-b", name: "Wrap", position: 1 });

    expect(pickRoadmapDateFields([a, b])).toEqual({ start: a, target: b });
  });

  it("has no ends at all when the project holds no date column", () => {
    const size = field({ id: "f-size", name: "Size", type: "number" });

    expect(pickRoadmapDateFields([size])).toEqual({ start: null, target: null });
  });
});

describe("planRoadmap", () => {
  it("draws a bar between the two dates a row holds", () => {
    const plan = planRoadmap([scheduled], start, target);

    expect(plan.bars).toEqual([
      { row: scheduled, start: "2026-09-01", end: "2026-10-15", partial: false },
    ]);
    expect(plan.unscheduled).toEqual([]);
  });

  it("draws a row with one date as a point, not as a row beside the chart", () => {
    // Hiding it would lose the one fact it has; stretching it to the edge would invent the one
    // it does not.
    const plan = planRoadmap([partial], start, target);

    expect(plan.bars[0]).toMatchObject({ start: "2026-09-20", end: "2026-09-20", partial: true });
  });

  it("lists a row with no dates beside the timeline rather than dropping it (AC-4)", () => {
    const plan = planRoadmap([scheduled, undated], start, target);

    expect(plan.bars).toHaveLength(1);
    expect(plan.unscheduled).toEqual([undated]);
  });

  it("spans exactly the rows' own extent", () => {
    const plan = planRoadmap([scheduled, partial], start, target);

    expect(plan.from).toBe("2026-09-01");
    expect(plan.to).toBe("2026-10-15");
  });

  it("still draws a row whose target precedes its start", () => {
    // The provider's data, not a reason to drop a row.
    const backwards = row("r4", "Backwards", {
      "f-start": { type: "date", date: "2026-10-01" },
      "f-target": { type: "date", date: "2026-09-01" },
    });

    expect(planRoadmap([backwards], start, target).bars[0]).toMatchObject({
      start: "2026-09-01",
      end: "2026-10-01",
    });
  });

  it("treats an unreadable date as no date rather than as an offset from 1970", () => {
    const nonsense = row("r5", "Someday", { "f-start": { type: "date", date: "soon" } });

    expect(planRoadmap([nonsense], start, target).unscheduled).toEqual([nonsense]);
  });
});

describe("ProjectRoadmap", () => {
  it("renders missing, partial and full dates in one pass, losing none of them", () => {
    render(<ProjectRoadmap fields={[start, target]} rows={[scheduled, partial, undated]} />);

    const timeline = screen.getByRole("region", { name: /timeline/i });
    expect(within(timeline).getByText("Ship the mirror")).toBeDefined();
    expect(within(timeline).getByText("Half a plan")).toBeDefined();

    const aside = screen.getByRole("complementary", { name: /not scheduled/i });
    expect(within(aside).getByText("Nobody has said when")).toBeDefined();
  });

  it("says a partial row has only one date, in words rather than only in a dash", () => {
    render(<ProjectRoadmap fields={[start, target]} rows={[partial]} />);

    expect(screen.getByText(/one date only/i)).toBeDefined();
  });

  it("counts the unscheduled rows, so 'none' is also said out loud", () => {
    render(<ProjectRoadmap fields={[start, target]} rows={[scheduled]} />);

    const aside = screen.getByRole("complementary", { name: /not scheduled/i });
    expect(aside.textContent).toContain("0");
    expect(within(aside).getByText(/everything here has a date/i)).toBeDefined();
  });

  it("says plainly that a project with no date column has nothing to lay out", () => {
    const size = field({ id: "f-size", name: "Size", type: "number" });

    render(<ProjectRoadmap fields={[size]} rows={[undated]} />);

    expect(screen.getByText(/no date field/i)).toBeDefined();
  });
});
