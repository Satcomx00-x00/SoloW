/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDiffDto } from "@solow/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DiffView } from "./diff-view";

/**
 * The diff view (task TASK-022). Approving is the one irreversible step in the loop, so what a
 * reviewer is shown before they press it has to be complete and honest: every changed file, and
 * a clear statement when the patch has been cut short or was never captured.
 */

afterEach(cleanup);

const diff = (over: Partial<TaskDiffDto> = {}): TaskDiffDto => ({
  diffRef: "solow/task-1",
  files: [
    { path: "src/latch.ts", status: "modified", additions: 12, deletions: 3 },
    { path: "src/heater.ts", status: "added", additions: 40, deletions: 0 },
    { path: "src/old-driver.ts", status: "deleted", additions: 0, deletions: 57 },
  ],
  patch: "diff --git a/src/latch.ts b/src/latch.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
  truncated: false,
  ...over,
});

describe("DiffView", () => {
  it("lists every changed file with its own totals", () => {
    render(<DiffView diff={diff()} branch="solow/task-1" />);

    const list = screen.getByLabelText("Changed files");
    for (const path of ["src/latch.ts", "src/heater.ts", "src/old-driver.ts"]) {
      expect(within(list).getByText(path)).toBeDefined();
    }
    expect(screen.getByText("3 files")).toBeDefined();
  });

  it("sums the change across files, so the size is readable at a glance", () => {
    render(<DiffView diff={diff()} branch="solow/task-1" />);
    expect(screen.getByText("+52")).toBeDefined();
    expect(screen.getByText("-60")).toBeDefined();
  });

  it("renders the patch body", () => {
    render(<DiffView diff={diff()} branch="solow/task-1" />);
    expect(screen.getByText("+new line")).toBeDefined();
    expect(screen.getByText("-old line")).toBeDefined();
  });

  it("says when the patch was cut short, rather than quietly showing part of it", () => {
    // A reviewer who cannot tell a truncated patch from a complete one may approve on a
    // partial read.
    render(<DiffView diff={diff({ truncated: true })} branch="solow/task-1" />);
    expect(screen.getByText(/Patch truncated/)).toBeDefined();
    expect(screen.getByText(/file list above is complete/)).toBeDefined();
  });

  it("does not claim truncation when the patch is whole", () => {
    render(<DiffView diff={diff()} branch="solow/task-1" />);
    expect(screen.queryByText(/Patch truncated/)).toBeNull();
  });

  it("distinguishes a failed capture from an empty change", () => {
    // Both would otherwise render as "nothing here", and they mean very different things.
    render(<DiffView diff={null} branch="solow/task-1" />);
    expect(screen.getByText(/was not captured/)).toBeDefined();
    expect(screen.getByText("solow/task-1")).toBeDefined();

    cleanup();
    render(<DiffView diff={diff({ files: [], patch: "" })} branch="solow/task-1" />);
    expect(screen.getByText(/finished without changing any files/)).toBeDefined();
  });

  it("shows nothing to review before a run has produced anything", () => {
    render(<DiffView diff={null} branch={null} />);
    expect(screen.getByText(/No proposed changes yet/)).toBeDefined();
  });
});
