/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { projectFilterSchema, projectFilterTermSchema } from "@solow/contracts";
import {
  type FilterableItem,
  formatProjectFilter,
  matchesProjectFilter,
  normaliseFilterKey,
  parseProjectFilter,
} from "./project-filter.js";

/**
 * The saved-view filter language (issue #129, F23 FR-11).
 *
 * Two things are being guarded here. One: a clause survives being written down and read back —
 * a view is stored as a predicate, and a predicate that loses a clause in the round trip is a
 * saved view that quietly shows the wrong rows. Two: a half-typed filter narrows to what has
 * been typed rather than emptying the table, because this box is typed into live.
 */

const item = (title: string, fields: Record<string, string[]> = {}): FilterableItem => ({
  title,
  fields,
});

describe("parseProjectFilter", () => {
  it("reads a bare word as a keyword clause", () => {
    expect(parseProjectFilter("upload")).toEqual({
      terms: [{ kind: "keyword", negated: false, text: "upload" }],
    });
  });

  it("reads a field clause, keeping a quoted value whole", () => {
    // `status:"In progress"` is the case that makes the language worth having: without quotes
    // the value would be two tokens and the second would silently become a keyword.
    expect(parseProjectFilter('status:"In progress"')).toEqual({
      terms: [{ kind: "field", negated: false, field: "status", values: ["In progress"] }],
    });
  });

  it("negates the clause it is attached to, not the whole filter", () => {
    const filter = parseProjectFilter("-label:blocked status:Todo");

    expect(filter.terms).toEqual([
      { kind: "field", negated: true, field: "label", values: ["blocked"] },
      { kind: "field", negated: false, field: "status", values: ["Todo"] },
    ]);
  });

  it("reads comma-separated values as one clause", () => {
    expect(parseProjectFilter("status:Todo,Doing").terms).toEqual([
      { kind: "field", negated: false, field: "status", values: ["Todo", "Doing"] },
    ]);
  });

  it("normalises a field name so punctuation is not part of the language", () => {
    // "Target date" is a column somebody can see. Making them reproduce its spacing would be a
    // syntax harder to type than the menu it replaces.
    expect(parseProjectFilter('"Target date":2026-09-01').terms[0]).toMatchObject({
      field: "targetdate",
    });
    expect(parseProjectFilter("target-date:2026-09-01").terms[0]).toMatchObject({
      field: "targetdate",
    });
  });

  it("drops a clause with no value yet instead of matching nothing", () => {
    // Typed live: at the instant the colon is pressed, `status:` must still mean "everything",
    // never "no rows" — a filter that blanks the table mid-keystroke is one people stop using.
    expect(parseProjectFilter("status: upload").terms).toEqual([
      { kind: "keyword", negated: false, text: "upload" },
    ]);
  });

  it("ends an unterminated quote at the end of the input", () => {
    expect(parseProjectFilter('status:"In prog').terms).toEqual([
      { kind: "field", negated: false, field: "status", values: ["In prog"] },
    ]);
  });

  it("drops a lone dash rather than making it a keyword", () => {
    expect(parseProjectFilter("-").terms).toEqual([]);
  });

  it("reads an empty filter as no clauses, which everything passes", () => {
    expect(parseProjectFilter("   ").terms).toEqual([]);
  });

  it("reads the whole example from the spec", () => {
    const filter = parseProjectFilter('status:"In progress" assignee:@me -label:blocked cap');

    expect(filter.terms).toEqual([
      { kind: "field", negated: false, field: "status", values: ["In progress"] },
      { kind: "field", negated: false, field: "assignee", values: ["@me"] },
      { kind: "field", negated: true, field: "label", values: ["blocked"] },
      { kind: "keyword", negated: false, text: "cap" },
    ]);
  });
});

describe("round-tripping through storage", () => {
  const inputs = [
    'status:"In progress" assignee:@me -label:blocked iteration:@current',
    "status:Todo,Doing,Done -size:XL",
    'title -"two words" repo:acme/web',
    'label:"needs \\"care\\""',
    "assignee:@none",
    "",
  ];

  for (const text of inputs) {
    it(`keeps every clause of \`${text}\``, () => {
      // Printed, re-read, serialised through the contract, and re-read again — the exact path a
      // saved view takes. A clause lost anywhere on it is a tab that shows the wrong rows.
      const parsed = parseProjectFilter(text);
      const reparsed = parseProjectFilter(formatProjectFilter(parsed));
      expect(reparsed).toEqual(parsed);

      const stored = projectFilterSchema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(stored).toEqual(parsed);
      expect(formatProjectFilter(stored)).toBe(formatProjectFilter(parsed));
    });
  }

  it("quotes a value the scanner would otherwise read as two tokens", () => {
    const filter = parseProjectFilter('status:"In progress"');

    expect(formatProjectFilter(filter)).toBe('status:"In progress"');
  });

  it("quotes a keyword that would otherwise read as a negation", () => {
    const filter = { terms: [{ kind: "keyword" as const, negated: false, text: "-dash" }] };

    expect(parseProjectFilter(formatProjectFilter(filter))).toEqual(filter);
  });
});

describe("matchesProjectFilter", () => {
  const row = item("Cap the upload size", {
    status: ["In progress"],
    assignee: ["satcom", "ana"],
    label: ["blocked", "backend"],
  });

  it("passes everything when there are no clauses", () => {
    expect(matchesProjectFilter({ terms: [] }, row)).toBe(true);
  });

  it("matches a keyword case-insensitively inside the title", () => {
    expect(matchesProjectFilter(parseProjectFilter("UPLOAD"), row)).toBe(true);
    expect(matchesProjectFilter(parseProjectFilter("download"), row)).toBe(false);
  });

  it("ANDs clauses and ORs the values inside one", () => {
    expect(matchesProjectFilter(parseProjectFilter('status:Todo,"In progress"'), row)).toBe(true);
    expect(matchesProjectFilter(parseProjectFilter('status:"In progress" upload'), row)).toBe(true);
    expect(matchesProjectFilter(parseProjectFilter('status:"In progress" download'), row)).toBe(
      false,
    );
  });

  it("excludes on a negated clause", () => {
    expect(matchesProjectFilter(parseProjectFilter("-label:blocked"), row)).toBe(false);
    expect(matchesProjectFilter(parseProjectFilter("-label:flaky"), row)).toBe(true);
  });

  it("resolves @me against the reader, not against whoever saved the view", () => {
    // A shared `My items` tab means "mine" for whoever opens it. Resolving at save time would
    // freeze the team's tab into one person's inbox.
    const filter = parseProjectFilter("assignee:@me");

    expect(matchesProjectFilter(filter, row, { me: "ana" })).toBe(true);
    expect(matchesProjectFilter(filter, row, { me: "someone-else" })).toBe(false);
  });

  it("matches nothing for @me when nobody is known, rather than everything", () => {
    // The failure this guards: an unauthenticated or unmapped reader seeing the whole project
    // under a tab that says `My items`.
    expect(matchesProjectFilter(parseProjectFilter("assignee:@me"), row, { me: null })).toBe(false);
  });

  it("resolves @current from the caller's answer for that field", () => {
    const sprinted = item("Cap the upload size", { iteration: ["Sprint 4"] });
    const filter = parseProjectFilter("iteration:@current");

    expect(matchesProjectFilter(filter, sprinted, { current: { iteration: ["Sprint 4"] } })).toBe(
      true,
    );
    expect(matchesProjectFilter(filter, sprinted, { current: { iteration: ["Sprint 5"] } })).toBe(
      false,
    );
    expect(matchesProjectFilter(filter, sprinted)).toBe(false);
  });

  it("matches @none on an empty cell, which is a question a planner actually asks", () => {
    expect(matchesProjectFilter(parseProjectFilter("size:@none"), row)).toBe(true);
    expect(matchesProjectFilter(parseProjectFilter("status:@none"), row)).toBe(false);
  });

  it("treats a field the row has never heard of as unmatched, not as an error", () => {
    // A view outlives a re-sync. Naming a column this project no longer has costs those rows,
    // and nothing else — never a table that fails to render.
    expect(matchesProjectFilter(parseProjectFilter("velocity:9"), row)).toBe(false);
    expect(matchesProjectFilter(parseProjectFilter("-velocity:9"), row)).toBe(true);
  });
});

describe("normaliseFilterKey", () => {
  it("folds case and punctuation so one column has one key", () => {
    expect(normaliseFilterKey("Target date")).toBe("targetdate");
    expect(normaliseFilterKey("Sub-issue progress")).toBe("subissueprogress");
    expect(normaliseFilterKey("Status")).toBe("status");
  });
});

describe("a clause whose field name normalises to nothing", () => {
  it("is dropped by the parser, not stored as a term the schema refuses", () => {
    // The silent failure this guards: the parser used to test the *raw* head and store the
    // *normalised* one, so `!!!:done` produced `{ field: "" }` — a shape `projectFilterTermSchema`
    // rejects with `.min(1)`. The table narrowed on screen and the view then failed to save, with
    // nothing said. The guard and the storage have to agree about what a clause is.
    expect(parseProjectFilter("!!!:done").terms).toEqual([]);
    expect(parseProjectFilter("---:x").terms).toEqual([]);
  });

  it("still reads a name that only *contains* punctuation", () => {
    // `start-date:` normalises to `startdate`, which is a field. Dropping punctuation is not the
    // same as being made of it.
    expect(parseProjectFilter("start-date:2026-08-25").terms[0]).toMatchObject({
      kind: "field",
      field: "startdate",
    });
  });

  it("keeps every term the schema would accept, so the round trip is total", () => {
    const parsed = parseProjectFilter('status:"In progress" -label:blocked');
    for (const term of parsed.terms) {
      expect(projectFilterTermSchema.safeParse(term).success).toBe(true);
    }
  });
});
