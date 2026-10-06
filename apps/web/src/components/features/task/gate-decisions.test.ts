/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { DecisionWidget } from "@solow/contracts";
import { gateDecisions } from "./gate-decisions";

const widget = (id: string): DecisionWidget =>
  ({
    kind: "decision",
    id,
    question: `${id}?`,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    chosen: "a",
  }) as DecisionWidget;

const at = (seq: number, sessionId = "s1") => ({ sessionId, seq });

describe("gateDecisions", () => {
  it("keeps only the decisions asked since the previous round closed", () => {
    // Specify asked one at seq 11 and its round closed at 18; Clarify asked two after that.
    const origin = new Map([
      ["decision:scope", at(11)],
      ["decision:files", at(35)],
      ["decision:python", at(36)],
    ]);
    const rounds = [{ closedAtSeq: 18 }, { closedAtSeq: null }];

    const ids = gateDecisions(
      [widget("scope"), widget("files"), widget("python")],
      origin,
      "s1",
      rounds,
    ).map((w) => w.id);

    expect(ids).toEqual(["files", "python"]);
  });

  it("keeps every decision while there is only one round", () => {
    const origin = new Map([["decision:scope", at(11)]]);
    expect(gateDecisions([widget("scope")], origin, "s1", [{ closedAtSeq: null }])).toHaveLength(1);
  });

  it("leaves out a decision from another Session, and keeps one whose position is unknown", () => {
    const origin = new Map([["decision:old", at(50, "s0")]]);
    const ids = gateDecisions([widget("old"), widget("unplaced")], origin, "s1", []).map(
      (w) => w.id,
    );
    expect(ids).toEqual(["unplaced"]);
  });
});
