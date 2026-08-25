/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { intralineRanges, parseUnifiedDiff, toSideBySide } from "./unified-diff";

/** A real capture from this repository — mnemonic prefixes (`c/`, `w/`) and all. */
const REAL = `diff --git c/requierements.txt w/requierements.txt
index b94897d..19f5aff 100644
--- c/requierements.txt
+++ w/requierements.txt
@@ -1,8 +1,8 @@
 logging
-tradingview-ta
-pandas_ta
-python-binance
+tradingview-ta==3.3.0
+pandas_ta==0.4.71b0
+python-binance==1.0.37
 binance-futures
-colorama
-pandas_datareader
+colorama==0.4.6
+pandas_datareader==0.11.1
 statistics
\\ No newline at end of file`;

describe("parseUnifiedDiff", () => {
  it("drops every line that is git talking to git", () => {
    const { hunks } = parseUnifiedDiff(REAL);
    const texts = hunks.flatMap((h) => h.lines.map((l) => l.text));

    for (const noise of ["diff --git", "index b94897d", "--- ", "+++ "]) {
      expect(texts.some((t) => t.includes(noise))).toBe(false);
    }
  });

  it("numbers both sides the way the file is numbered", () => {
    const [hunk] = parseUnifiedDiff(REAL).hunks;

    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.lines[0]).toMatchObject({
      kind: "context",
      oldLine: 1,
      newLine: 1,
      text: "logging",
    });
    // Four deletions consumed old lines 2-4 without advancing the new side.
    expect(hunk?.lines[1]).toMatchObject({ kind: "deleted", oldLine: 2, newLine: null });
    expect(hunk?.lines[4]).toMatchObject({ kind: "added", oldLine: null, newLine: 2 });
    // ...and the context line after the block is line 5 on both sides again.
    expect(hunk?.lines[7]).toMatchObject({
      kind: "context",
      oldLine: 5,
      newLine: 5,
      text: "binance-futures",
    });
  });

  it("attaches the no-newline marker to the line it describes", () => {
    const { hunks } = parseUnifiedDiff(REAL);
    const last = hunks[0]?.lines.at(-1);

    expect(last?.text).toBe("statistics");
    expect(last?.noNewline).toBe(true);
  });

  it("reads the path from the destination header, whatever prefix git used", () => {
    expect(parseUnifiedDiff(REAL).path).toBe("requierements.txt");
  });

  it("keeps an unchanged empty line rather than dropping it", () => {
    // Some tools strip the trailing space from a context line, leaving a bare "".
    const { hunks } = parseUnifiedDiff("@@ -1,2 +1,2 @@\n a\n\n-b\n+c");

    expect(hunks[0]?.lines.map((l) => l.kind)).toEqual(["context", "context", "deleted", "added"]);
  });

  it("reads several hunks in one file", () => {
    const { hunks } = parseUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +50,1 @@\n-y\n+z");

    expect(hunks).toHaveLength(2);
    expect(hunks[1]?.oldStart).toBe(50);
  });

  it("carries the function name git puts after the @@", () => {
    expect(
      parseUnifiedDiff("@@ -1,1 +1,1 @@ function readScmStatus()\n-a\n+b").hunks[0]?.heading,
    ).toBe("function readScmStatus()");
  });

  it("reports a patch with no hunks as empty rather than as a change", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ",
    );

    expect(parsed.empty).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });
});

describe("toSideBySide", () => {
  it("puts a rewritten line opposite its replacement", () => {
    // The whole point: five rows apart in the patch, one row in an editor.
    const rows = toSideBySide(parseUnifiedDiff(REAL).hunks[0]?.lines ?? []);
    const change = rows.find((r) => r.left.text === "tradingview-ta");

    expect(change?.kind).toBe("change");
    expect(change?.right.text).toBe("tradingview-ta==3.3.0");
  });

  it("leaves the shorter side empty when a block is not symmetrical", () => {
    const rows = toSideBySide(
      parseUnifiedDiff("@@ -1,2 +1,1 @@\n-a\n-b\n+c").hunks[0]?.lines ?? [],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "change", left: { text: "a" }, right: { text: "c" } });
    expect(rows[1]).toMatchObject({ kind: "deleted", left: { text: "b" }, right: { text: null } });
  });

  it("shows a pure addition with nothing opposite it", () => {
    const rows = toSideBySide(parseUnifiedDiff("@@ -1,0 +1,1 @@\n+new").hunks[0]?.lines ?? []);

    expect(rows[0]).toMatchObject({ kind: "added", left: { text: null, line: null } });
  });

  it("repeats a context line on both sides, with each side's own number", () => {
    const rows = toSideBySide(parseUnifiedDiff("@@ -3,1 +7,1 @@\n same").hunks[0]?.lines ?? []);

    expect(rows[0]).toMatchObject({
      kind: "context",
      left: { line: 3, text: "same" },
      right: { line: 7, text: "same" },
    });
  });
});

describe("intralineRanges", () => {
  it("marks only the part of the line that actually changed", () => {
    const ranges = intralineRanges("tradingview-ta", "tradingview-ta==3.3.0");

    expect(ranges?.left).toEqual({ start: 14, end: 14 });
    expect("tradingview-ta==3.3.0".slice(ranges?.right.start, ranges?.right.end)).toBe("==3.3.0");
  });

  it("finds a change in the middle, keeping both ends", () => {
    const ranges = intralineRanges("const a = 1;", "const b = 1;");

    expect("const a = 1;".slice(ranges?.left.start, ranges?.left.end)).toBe("a");
    expect("const b = 1;".slice(ranges?.right.start, ranges?.right.end)).toBe("b");
  });

  it("marks nothing when the lines are identical", () => {
    expect(intralineRanges("same", "same")).toBeNull();
  });

  it("marks nothing when almost everything changed", () => {
    // Highlighting end-to-end reads as noise; the row colour already says the line changed.
    expect(intralineRanges("alpha beta gamma", "completely different text")).toBeNull();
  });
});
