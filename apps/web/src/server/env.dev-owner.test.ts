import { afterEach, describe, expect, it } from "bun:test";
import { devOwnerMode, orchestratorSecret } from "./env.js";

describe("orchestratorSecret", () => {
  const saved = process.env.SOLOW_ORCHESTRATOR_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOLOW_ORCHESTRATOR_SECRET;
    else process.env.SOLOW_ORCHESTRATOR_SECRET = saved;
  });

  it("applies the orchestrator's own rule, so a value one side refuses is never sent", () => {
    process.env.SOLOW_ORCHESTRATOR_SECRET = "x";
    expect(orchestratorSecret()).toBeUndefined();
  });

  it("returns a secret of the required length", () => {
    process.env.SOLOW_ORCHESTRATOR_SECRET = "a-long-enough-orchestrator-secret";
    expect(orchestratorSecret()).toBe("a-long-enough-orchestrator-secret");
  });
});

describe("devOwnerMode", () => {
  const saved = process.env.SOLOW_DEV_OWNER;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOLOW_DEV_OWNER;
    else process.env.SOLOW_DEV_OWNER = saved;
  });

  it("is off unless explicitly switched on, so sign-in is the default", () => {
    delete process.env.SOLOW_DEV_OWNER;
    expect(devOwnerMode()).toBe(false);
  });

  it("is on only for the exact value 'on'", () => {
    process.env.SOLOW_DEV_OWNER = "on";
    expect(devOwnerMode()).toBe(true);
  });
});
