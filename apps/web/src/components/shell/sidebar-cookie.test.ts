/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { clampSidebarWidth } from "./sidebar-cookie";

describe("clampSidebarWidth", () => {
  it("keeps a stored width inside the limits", () => {
    expect(clampSidebarWidth("280")).toBe(280);
    expect(clampSidebarWidth("90")).toBe(200);
    expect(clampSidebarWidth(9000)).toBe(360);
  });

  it("falls back to the default for anything it cannot read", () => {
    expect(clampSidebarWidth(undefined)).toBe(240);
    expect(clampSidebarWidth("wide")).toBe(240);
  });
});
