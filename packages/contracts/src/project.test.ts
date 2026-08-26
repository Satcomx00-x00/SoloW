/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ProjectFieldType, ProjectFieldValue } from "./project.js";
import { parseProjectFieldValue, projectFieldValueSchema } from "./project.js";

/**
 * `parseProjectFieldValue` is the whole of #121 AC-3, and it exists for one failure: a stored
 * value whose shape no longer matches its field. That happens for ordinary reasons — a provider
 * changed a field's type, an older build wrote a shape this one does not know — and the cost has
 * to be one empty cell. Inside a virtualized grid, a throw here takes the viewport with it.
 */
describe("parseProjectFieldValue", () => {
  it("reads a value back as the type its field says it is", () => {
    expect(parseProjectFieldValue("number", { type: "number", number: 8 })).toEqual({
      type: "number",
      number: 8,
    });
    expect(
      parseProjectFieldValue("single_select", { type: "single_select", optionId: "o1" }),
    ).toEqual({ type: "single_select", optionId: "o1" });
  });

  it("trusts the field's type over the value's own tag", () => {
    // A value tagged `number` sitting in a field that is now `text` is a value in the wrong
    // shape. Trusting its tag would hand the text renderer a number.
    expect(parseProjectFieldValue("text", { type: "number", number: 8 })).toBeNull();
  });

  it("returns null for a shape it cannot read, rather than throwing", () => {
    for (const raw of [
      { type: "number", number: "eight" },
      { type: "does_not_exist", whatever: 1 },
      { number: 8 },
      "a bare string",
      42,
      [],
    ]) {
      expect(parseProjectFieldValue("number", raw)).toBeNull();
    }
  });

  it("treats an absent value as absent, not as an error", () => {
    expect(parseProjectFieldValue("text", null)).toBeNull();
    expect(parseProjectFieldValue("text", undefined)).toBeNull();
  });

  it("reads every type in the union", () => {
    const cases: Array<[ProjectFieldType, ProjectFieldValue]> = [
      ["text", { type: "text", text: "hello" }],
      ["number", { type: "number", number: 3 }],
      ["date", { type: "date", date: "2026-08-25" }],
      ["single_select", { type: "single_select", optionId: "opt" }],
      ["iteration", { type: "iteration", iterationId: "it" }],
      ["url", { type: "url", url: "https://example.test" }],
      ["user", { type: "user", users: [{ login: "satcom", name: null, avatarUrl: null }] }],
    ];
    for (const [type, value] of cases) {
      expect(parseProjectFieldValue(type, value)).toEqual(value);
    }
  });

  it("keeps an empty user list, which is a value and not an absence", () => {
    // "Nobody is assigned" is a fact the provider stated. It is not the same as never having
    // been asked, and a table that renders them identically cannot show an unassignment.
    expect(parseProjectFieldValue("user", { type: "user", users: [] })).toEqual({
      type: "user",
      users: [],
    });
  });

  it("accepts a number of zero and an empty string, which are values", () => {
    expect(parseProjectFieldValue("number", { type: "number", number: 0 })).toEqual({
      type: "number",
      number: 0,
    });
    expect(parseProjectFieldValue("text", { type: "text", text: "" })).toEqual({
      type: "text",
      text: "",
    });
  });

  it("refuses a user entry that is not a user", () => {
    expect(projectFieldValueSchema.safeParse({ type: "user", users: ["satcom"] }).success).toBe(
      false,
    );
  });
});
