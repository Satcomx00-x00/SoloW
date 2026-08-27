/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { PAGE_SIZE_DEFAULT } from "@solow/contracts";
import { decodeCursor, encodeCursor, pageLimit, pageProbe, toPage } from "./page";

/**
 * The paging primitives behind issue #82 AC-4.
 *
 * The claim the whole feature rests on: **a caller that asks for nothing is bounded**. Every list
 * this serves is also an MCP tool, so "unbounded unless someone remembers to bound it" is the one
 * outcome that must be impossible — the callers most likely to forget are the ones the bound was
 * written for.
 *
 * The rest is about the cursor being honest at the boundary: a last page that is exactly `limit`
 * rows must not hand back a cursor leading to nothing, and a cursor must survive a round trip
 * without a caller being able to read what is in it.
 */

const row = (id: string, createdAt: string) => ({ id, createdAt });

describe("pageLimit", () => {
  it("bounds a caller that asked for nothing", () => {
    // The whole point. `undefined` is what a tool call, a test and a seed script all send.
    expect(pageLimit(undefined)).toBe(PAGE_SIZE_DEFAULT);
  });

  it("honours a caller that asked for a size", () => {
    expect(pageLimit(25)).toBe(25);
  });
});

describe("toPage", () => {
  it("cuts the probe row off the page and turns it into a cursor", () => {
    // `pageProbe` reads one extra row so "is there more?" costs no second query.
    const rows = [row("c", "2026-08-03"), row("b", "2026-08-02"), row("a", "2026-08-01")];

    const page = toPage(rows, pageProbe(2) - 1, (r) => r);

    expect(page.items.map((r) => r.id)).toEqual(["c", "b"]);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
      createdAt: "2026-08-02",
      id: "b",
    });
  });

  it("ends the walk when the last page is exactly full", () => {
    // The off-by-one that matters: a full page is not evidence of another one. A cursor here
    // would lead to an empty page, and a caller that trusted it would show a "load more" that
    // loads nothing.
    const rows = [row("b", "2026-08-02"), row("a", "2026-08-01")];

    expect(toPage(rows, 2, (r) => r).nextCursor).toBeNull();
  });

  it("answers for an empty read without inventing a cursor", () => {
    expect(toPage([], 10, (r: { id: string; createdAt: string }) => r)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe("the cursor", () => {
  it("round-trips the pair it carries", () => {
    const cursor = encodeCursor({ createdAt: "2026-08-27T09:15:00.000Z", id: "iss-42" });

    expect(decodeCursor(cursor)).toEqual({ createdAt: "2026-08-27T09:15:00.000Z", id: "iss-42" });
  });

  it("is opaque — not a value a caller could have constructed by reading the ordering", () => {
    const cursor = encodeCursor({ createdAt: "2026-08-27T09:15:00.000Z", id: "iss-42" });

    expect(cursor).not.toContain("iss-42");
    expect(cursor).not.toContain("2026");
  });

  it("reads a malformed cursor as no cursor, rather than failing the list", () => {
    // It is opaque, so a caller holding a broken one got it from a version of this code that
    // encoded it differently. Answering the first page beats failing a list over a stale
    // bookmark.
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});
