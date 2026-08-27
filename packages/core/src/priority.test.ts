import { describe, expect, it } from "bun:test";
import {
  isPriorityFieldName,
  priorityFromLabel,
  priorityFromLabels,
  withPriorityLabel,
} from "./priority.js";

/**
 * Reading a priority off labels.
 *
 * The property under test throughout: **a label that is not a priority reads as no priority.**
 * Every false positive here becomes a value in a Priority column that nobody set, which is worse
 * than the empty cell it replaced — an empty cell is obviously empty, and a wrong one is not.
 */

describe("priorityFromLabel", () => {
  it("reads the numbered form every scope punctuation produces", () => {
    for (const label of ["prio/p1", "priority::p1", "priority: p1", "pri-p1", "priority_p1"]) {
      expect(priorityFromLabel(label)).toEqual({ rank: 1, name: "P1", label });
    }
  });

  it("reads a bare PN, which is GitHub's own convention", () => {
    expect(priorityFromLabel("P0")).toEqual({ rank: 0, name: "P0", label: "P0" });
  });

  it("reads the named form, in the word the team wrote", () => {
    expect(priorityFromLabel("priority::critical")?.name).toBe("Critical");
    expect(priorityFromLabel("high priority")?.name).toBe("High");
    expect(priorityFromLabel("low-priority")?.name).toBe("Low");
  });

  it("sorts the named and numbered vocabularies against each other", () => {
    // The whole point of a rank: two teams' spellings have to be comparable, or a project that
    // uses both cannot be sorted at all.
    const urgent = priorityFromLabel("priority::urgent")?.rank ?? -1;
    const p3 = priorityFromLabel("prio/p3")?.rank ?? -1;
    expect(urgent).toBeLessThan(p3);
  });

  it("refuses a word that is only a priority when something scopes it", () => {
    // `high` on its own is as likely to be about a log level, a memory limit or a bug's severity.
    expect(priorityFromLabel("high")).toBeNull();
    expect(priorityFromLabel("low")).toBeNull();
  });

  it("refuses a bare number, which says nothing on its own", () => {
    expect(priorityFromLabel("3")).toBeNull();
  });

  it("refuses the ordinary labels a project is full of", () => {
    for (const label of [
      "type/feat",
      "size/l",
      "area/crawler",
      "status/needs-info",
      "perf",
      "polish",
      "enhancement",
      "",
    ]) {
      expect(priorityFromLabel(label)).toBeNull();
    }
  });

  it("keeps the label verbatim, so a cell can say where the value came from", () => {
    // Case included: the attribution is quoted back to the operator, and re-casing it would show
    // them a label their provider does not have.
    expect(priorityFromLabel("Prio/P2")?.label).toBe("Prio/P2");
  });
});

describe("priorityFromLabels", () => {
  it("answers with the most urgent, not the first listed", () => {
    // An issue carrying both has been escalated. Reporting `p3` would hide the escalation.
    expect(priorityFromLabels(["prio/p3", "priority::critical"])?.name).toBe("Critical");
  });

  it("keeps the provider's order on a tie, so the answer does not flicker between renders", () => {
    expect(priorityFromLabels(["priority::high", "prio/p1"])?.label).toBe("priority::high");
  });

  it("is null for an issue whose labels say nothing about priority", () => {
    expect(priorityFromLabels(["type/feat", "area/web"])).toBeNull();
    expect(priorityFromLabels([])).toBeNull();
  });
});

describe("isPriorityFieldName", () => {
  it("matches the column however the provider spaces or cases it", () => {
    expect(isPriorityFieldName("Priority")).toBe(true);
    expect(isPriorityFieldName(" priority ")).toBe(true);
  });

  it("does not claim a column it cannot answer for", () => {
    // Deriving into `Prioridad` would be putting a value in a column on the strength of a guess.
    expect(isPriorityFieldName("Prioridad")).toBe(false);
    expect(isPriorityFieldName("Size")).toBe(false);
  });
});

describe("withPriorityLabel", () => {
  it("keeps every label that is not a priority", () => {
    // The failure this exists to prevent: a provider takes a whole label set, so a priority change
    // that forgot to send `area/web` back would delete it from the issue.
    expect(withPriorityLabel(["type/feat", "area/web", "prio/p3"], "prio/p1")).toEqual([
      "type/feat",
      "area/web",
      "prio/p1",
    ]);
  });

  it("replaces the priority rather than adding a second one", () => {
    expect(withPriorityLabel(["prio/p3"], "prio/p1")).toEqual(["prio/p1"]);
  });

  it("drops every priority label when several had accumulated", () => {
    // An issue can arrive carrying two, and setting a priority has to leave exactly one.
    expect(withPriorityLabel(["prio/p3", "priority::high", "type/fix"], "prio/p1")).toEqual([
      "type/fix",
      "prio/p1",
    ]);
  });

  it("clears the priority and moves nothing else", () => {
    expect(withPriorityLabel(["type/feat", "prio/p1"], null)).toEqual(["type/feat"]);
  });

  it("adds one to an issue that had none", () => {
    expect(withPriorityLabel(["type/feat"], "prio/p2")).toEqual(["type/feat", "prio/p2"]);
  });
});
