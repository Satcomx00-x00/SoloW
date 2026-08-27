/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ScmFileDto, ScmWorktreeDto } from "@solow/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SourceControlPanel } from "./source-control-panel";

/**
 * The source-control panel (spec F22).
 *
 * What is asserted here is mostly *restraint*: that there is no commit button, that a conflict
 * offers no stage, that a discard says the true word for what it is about to do, and that a
 * worktree the server marked read-only offers nothing at all. The panel's value is that it
 * behaves like the editor people already use; its safety is in the places it deliberately does
 * not.
 */

afterEach(cleanup);

const file = (over: Partial<ScmFileDto> & Pick<ScmFileDto, "path" | "group">): ScmFileDto => ({
  kind: "modified",
  letter: "M",
  additions: 3,
  deletions: 1,
  binary: false,
  ...over,
});

const worktree = (over: Partial<ScmWorktreeDto> = {}): ScmWorktreeDto => ({
  attachmentId: "att-1",
  repositoryId: "repo-1",
  repositoryName: "bot",
  branch: {
    name: "solow/task-1",
    detached: false,
    head: "abc12345",
    upstream: null,
    ahead: 0,
    behind: 0,
  },
  files: [
    file({ path: "src/staged.ts", group: "staged" }),
    file({ path: "src/changed.ts", group: "changes" }),
    file({ path: "new.txt", group: "untracked", kind: "untracked", letter: "?" }),
  ],
  total: 3,
  truncated: false,
  writable: true,
  readOnlyReason: null,
  ...over,
});

function renderPanel(over: Partial<ScmWorktreeDto> = {}, view: "tree" | "list" = "list") {
  const actions = {
    onStage: mock(() => {}),
    onUnstage: mock(() => {}),
    onDiscard: mock(() => {}),
    onRefresh: mock(() => {}),
  };
  render(
    <SourceControlPanel
      worktree={worktree(over)}
      view={view}
      onViewChange={() => {}}
      selectedPath={null}
      onSelect={() => {}}
      {...actions}
    />,
  );
  return actions;
}

describe("SourceControlPanel", () => {
  it("groups files the way an editor does, with a count on each", () => {
    renderPanel();

    // By list label, not by button name: "Staged Changes" is a substring of the group header
    // *and* of its "Unstage all" action, and a loose match here would pass for the wrong reason.
    for (const label of ["Staged Changes", "Changes", "Untracked"]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
    expect(within(screen.getByLabelText("Staged Changes")).getByText("staged.ts")).toBeDefined();
    expect(within(screen.getByLabelText("Untracked")).getByText("new.txt")).toBeDefined();
  });

  it("omits a group nothing is in, rather than showing an empty heading", () => {
    renderPanel({ files: [file({ path: "a.ts", group: "changes" })], total: 1 });

    expect(screen.queryByLabelText("Staged Changes")).toBeNull();
    expect(screen.getByLabelText("Changes")).toBeDefined();
  });

  it("has no commit button — the review gate is the commit (FR-7)", () => {
    // The single most important assertion in this file. A commit here would be a path from
    // agent output to a branch with no recorded decision (Principle I).
    renderPanel();

    expect(screen.queryByRole("button", { name: /commit/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("stages a single file by its own name", () => {
    const actions = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Stage changed.ts" }));

    expect(actions.onStage).toHaveBeenCalledWith(["src/changed.ts"]);
  });

  it("stages a whole group in one call", () => {
    const actions = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Stage all in Changes" }));

    expect(actions.onStage).toHaveBeenCalledWith(["src/changed.ts"]);
  });

  it("offers unstage on staged files and stage on the rest", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Unstage staged.ts" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Stage staged.ts" })).toBeNull();
    // Unstaging must never throw work away, so a staged row offers no discard either.
    expect(screen.queryByRole("button", { name: "Discard staged.ts" })).toBeNull();
  });

  it("offers nothing to act on for a conflicted file", () => {
    // Staging one half of an unresolved merge records a decision nobody made.
    renderPanel({
      files: [file({ path: "src/c.ts", group: "merge", kind: "conflicted", letter: "U" })],
      total: 1,
    });

    expect(screen.getByLabelText("Merge Changes")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Stage / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Discard / })).toBeNull();
  });

  it("offers no writes at all when the server says the worktree is read-only", () => {
    const reason = "The agent is still working. Changes can be staged once it reaches review.";
    renderPanel({ writable: false, readOnlyReason: reason });

    expect(screen.getByText(reason)).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Stage / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unstage / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Discard / })).toBeNull();
  });
});

describe("discarding", () => {
  it("asks first, and says 'reverted' for a tracked file", () => {
    const actions = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Discard changed.ts" }));

    expect(actions.onDiscard).not.toHaveBeenCalled();
    expect(screen.getByText(/reverted to the last commit/i)).toBeDefined();
  });

  it("says 'deleted' for an untracked file, because that is what happens", () => {
    // "Discard" reads as "revert". For a file git has never seen it means delete, and there is
    // no commit to bring it back from.
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Discard new.txt" }));

    expect(screen.getByText(/deleted from the worktree/i)).toBeDefined();
    expect(screen.getByText(/no commit to restore it from/i)).toBeDefined();
  });

  it("discards only once the confirmation is accepted", () => {
    const actions = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Discard changed.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(actions.onDiscard).toHaveBeenCalledWith(["src/changed.ts"]);
  });

  it("discards nothing when the confirmation is dismissed", () => {
    const actions = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Discard changed.ts" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(actions.onDiscard).not.toHaveBeenCalled();
  });
});

describe("the header", () => {
  it("names the branch and its upstream distance", () => {
    renderPanel({
      branch: {
        name: "feature",
        detached: false,
        head: "abc12345",
        upstream: "origin/feature",
        ahead: 2,
        behind: 1,
      },
    });

    expect(screen.getByText("feature")).toBeDefined();
    expect(screen.getByText(/origin\/feature.*↑2.*↓1/)).toBeDefined();
  });

  it("names a detached HEAD as detached rather than as a branch", () => {
    renderPanel({
      branch: { name: null, detached: true, head: "abc12345", upstream: null, ahead: 0, behind: 0 },
    });

    expect(screen.getByText("detached HEAD")).toBeDefined();
  });

  it("says when the list was cut short rather than showing a short list silently", () => {
    renderPanel({ total: 4000, truncated: true });

    expect(screen.getByText(/showing 3 of 4000 changed files/i)).toBeDefined();
  });

  it("refreshes on demand", () => {
    const actions = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Refresh source control" }));

    expect(actions.onRefresh).toHaveBeenCalled();
  });
});

describe("the tree view", () => {
  it("nests files under collapsed directory chains", () => {
    renderPanel(
      {
        files: [
          file({ path: "apps/web/src/a.ts", group: "changes" }),
          file({ path: "apps/web/src/b.ts", group: "changes" }),
        ],
        total: 2,
      },
      "tree",
    );

    const list = screen.getByLabelText("Changes");
    expect(within(list).getByText("apps/web/src")).toBeDefined();
    expect(within(list).getByText("a.ts")).toBeDefined();
  });
});
