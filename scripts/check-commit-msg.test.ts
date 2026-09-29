/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { checkCommitMessage } from "./check-commit-msg.ts";

describe("the commit-msg hook", () => {
  it("accepts the subjects this repository writes", () => {
    for (const subject of [
      "feat(tasks): a Task can have sub-tasks (#56)",
      "fix: a bare type with no scope",
      "feat(api)!: a breaking change marked in the subject",
      "chore(release): v0.18.0",
      "build(release): git-cliff writes CHANGELOG.md",
      "Feat(task): the type is read case-insensitively, as the release reads it",
    ]) {
      expect(checkCommitMessage(`${subject}\n\nA body.\n`)).toBeNull();
    }
  });

  it("refuses a subject that is not a Conventional Commit, and says what it expected", () => {
    const problem = checkCommitMessage("Fixed the thing\n");
    expect(problem).toContain('not a Conventional Commit: "Fixed the thing"');
    expect(problem).toContain("<type>(<scope>)");
  });

  it("refuses a typo in the type — it would parse, move no digit and leave the changelog", () => {
    const problem = checkCommitMessage("feta(task): close enough\n");
    expect(problem).toContain('unknown commit type "feta"');
    expect(problem).toContain("feat, fix");
  });

  it("lets through what git writes itself or a rebase will fold away", () => {
    for (const subject of [
      "Merge branch 'main' into feat/x",
      "Merge remote-tracking branch 'origin/main' into claude/agent-catalog-10",
      "Merge pull request #132 from Satcomx00-x00/claude/release-trigger",
      'Revert "feat(task): something"',
      "fixup! feat(task): something",
      "squash! fix: other",
      "amend! docs: typo",
    ]) {
      expect(checkCommitMessage(subject)).toBeNull();
    }
  });

  it("reads the message git will keep: comments and the scissors block are not the subject", () => {
    const editor = [
      "# Please enter the commit message for your changes.",
      "fix(web): the real subject",
      "",
      "# On branch main",
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
    ].join("\n");
    expect(checkCommitMessage(editor)).toBeNull();
    expect(checkCommitMessage("# only a comment\n")).toBeNull();
  });
});
