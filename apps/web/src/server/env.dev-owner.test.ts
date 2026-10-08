import { afterEach, describe, expect, it } from "bun:test";
import { devOwnerMode } from "./env.js";

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
