/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { workflowStepGateSchema } from "@solow/contracts";
import { effectiveGate, GATE_DESCRIPTION, GATE_NAME } from "./workflow-gates";

describe("effectiveGate", () => {
  it("is the stored gate for a Step finished on the harness's signal", () => {
    for (const gate of workflowStepGateSchema.options) {
      expect(effectiveGate({ gate, advanceOn: "agent-signal" })).toBe(gate);
    }
  });

  it("waits for review on a Step finished by a review, whatever its gate says", () => {
    for (const gate of workflowStepGateSchema.options) {
      expect(effectiveGate({ gate, advanceOn: "review" })).toBe("human");
    }
  });
});

describe("gate names", () => {
  it("gives every gate one name of its own, and a sentence saying what it does", () => {
    const names = workflowStepGateSchema.options.map((gate) => GATE_NAME[gate]);
    expect(new Set(names).size).toBe(names.length);
    for (const gate of workflowStepGateSchema.options) {
      expect(GATE_DESCRIPTION[gate].endsWith(".")).toBe(true);
    }
  });
});
