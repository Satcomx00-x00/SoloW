import { describe, expect, it } from "bun:test";
import { deriveCostUsd, type ModelPrice, totalUsage } from "./pricing.js";

const PRICES: Record<string, ModelPrice> = {
  "test-model": { input: 10, output: 100, cacheRead: 1, cacheWrite: 20 },
};

const turn = (over: Partial<Parameters<typeof deriveCostUsd>[0]> = {}) => ({
  model: "test-model",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe("deriveCostUsd", () => {
  it("prices each token class at its own rate", () => {
    const cost = deriveCostUsd(
      turn({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
      PRICES,
    );
    expect(cost).toBe(10 + 100 + 1 + 20);
  });

  it("returns null for an unknown model rather than inventing a number", () => {
    expect(deriveCostUsd(turn({ model: "never-heard-of-it" }), PRICES)).toBeNull();
  });

  it("returns null when the agent did not state a model", () => {
    expect(deriveCostUsd(turn({ model: null }), PRICES)).toBeNull();
  });

  it("returns null, not NaN, for a model named like an Object.prototype member", () => {
    // `prices["constructor"]` resolves to an inherited function on a plain object literal;
    // multiplying by it yields NaN — a wrong number where the contract promises null.
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(deriveCostUsd(turn({ model: name, inputTokens: 1_000 }), PRICES)).toBeNull();
    }
  });

  it("is a pure function of the counts, so a price change never rewrites history", () => {
    const usage = turn({ inputTokens: 2_000_000 });
    expect(deriveCostUsd(usage, PRICES)).toBe(20);
    // The same recorded counts, priced under a later, different table.
    const repriced = { "test-model": { ...PRICES["test-model"], input: 5 } } as Record<
      string,
      ModelPrice
    >;
    expect(deriveCostUsd(usage, repriced)).toBe(10);
    // ...and the record itself is untouched by either valuation.
    expect(usage.inputTokens).toBe(2_000_000);
  });
});

describe("totalUsage", () => {
  it("keeps unpriced and unreported turns visible instead of counting them as free", () => {
    const totals = totalUsage(
      [
        { ...turn({ inputTokens: 1_000_000 }), reported: true },
        { ...turn({ model: "unknown-model", inputTokens: 5_000_000 }), reported: true },
        { ...turn(), reported: false },
      ],
      PRICES,
    );

    // Only the priced turn contributes to cost...
    expect(totals.costUsd).toBe(10);
    // ...but the unpriced turn's tokens are still real and still counted.
    expect(totals.inputTokens).toBe(6_000_000);
    // ...and both kinds of gap are reported, so the total is not mistaken for complete.
    expect(totals.unpricedTurns).toBe(1);
    expect(totals.unreportedTurns).toBe(1);
  });

  it("excludes an unreported turn's counts, which are not zero but unknown", () => {
    const totals = totalUsage([{ ...turn({ inputTokens: 999 }), reported: false }], PRICES);
    expect(totals.inputTokens).toBe(0);
    expect(totals.unreportedTurns).toBe(1);
  });
});
