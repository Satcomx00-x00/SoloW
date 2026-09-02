/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { newRowId } from "./row-id";

/**
 * The property that matters is not the shape of the id, it is that asking for one never throws.
 *
 * This replaced `crypto.randomUUID()`, which is a secure-context API: present on `localhost`,
 * absent over plain HTTP, and therefore absent exactly when someone opens their local install
 * from another machine on the LAN — the address Next prints on every boot. It failed inside a
 * `useState` initialiser, so the whole Settings page rendered "Application error" instead of a
 * form.
 */

describe("newRowId", () => {
  it("never repeats within a page load, which is all a React key needs", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRowId()));
    expect(ids.size).toBe(1000);
  });

  it("works with no crypto at all", () => {
    // Not a contrived scenario: this is what the browser hands a page served over plain HTTP.
    const original = globalThis.crypto;
    // @ts-expect-error deliberately removing a global the runtime normally guarantees
    globalThis.crypto = undefined;
    try {
      expect(() => newRowId()).not.toThrow();
      expect(typeof newRowId()).toBe("string");
    } finally {
      globalThis.crypto = original;
    }
  });

  it("works when crypto exists but randomUUID does not — the actual browser case", () => {
    const original = globalThis.crypto;
    // A non-secure context still has `crypto` (getRandomValues, subtle); it is `randomUUID`
    // alone that is missing, which is why a `typeof crypto` guard would not have caught this.
    // @ts-expect-error narrowing the global to the shape a non-secure context provides
    globalThis.crypto = { getRandomValues: original.getRandomValues.bind(original) };
    try {
      expect(() => newRowId()).not.toThrow();
    } finally {
      globalThis.crypto = original;
    }
  });
});
