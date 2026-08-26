/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { matches } from "./adopt-project-dialog";

/**
 * The adopt picker's filter.
 *
 * A token on a company account can see dozens of projects across several organizations, most of
 * them nothing to do with the operator. The list was scrollable and nothing else, so the question
 * "is my project here?" was answered by reading.
 */

const candidate = (over: Partial<Parameters<typeof matches>[0]> = {}) => ({
  title: "Roadmap",
  ownerLogin: "acme",
  provider: "github",
  ...over,
});

describe("matches", () => {
  it("matches on the title, case-insensitively", () => {
    expect(matches(candidate(), "road")).toBe(true);
    expect(matches(candidate(), "ROAD")).toBe(true);
    expect(matches(candidate(), "ladder")).toBe(false);
  });

  it("matches on the owner, which is as often the distinguishing word as the title", () => {
    // Two organizations both have a "Roadmap"; typing the org is the obvious way to reach one,
    // and a title-only filter answers it with nothing.
    expect(matches(candidate(), "acme")).toBe(true);
    expect(matches(candidate({ ownerLogin: "other" }), "acme")).toBe(false);
  });

  it("takes the words in any order, because nobody remembers which comes first", () => {
    expect(matches(candidate(), "acme road")).toBe(true);
    expect(matches(candidate(), "road acme")).toBe(true);
  });

  it("requires every word, so a second word narrows rather than widens", () => {
    expect(matches(candidate(), "acme ladder")).toBe(false);
  });

  it("keeps everything on an empty query", () => {
    // Typing and then clearing must return the full list, not an empty one.
    expect(matches(candidate(), "")).toBe(true);
    expect(matches(candidate(), "   ")).toBe(true);
  });

  it("does not crash on a project whose owner the provider did not report", () => {
    expect(matches(candidate({ ownerLogin: null }), "road")).toBe(true);
    expect(matches(candidate({ ownerLogin: null }), "acme")).toBe(false);
  });
});
