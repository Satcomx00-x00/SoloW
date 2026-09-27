import { describe, expect, it } from "bun:test";
import { orderRunLinks, runLinkOf, runLinksFrom, runLinksIn } from "./run-links.js";

describe("runLinkOf", () => {
  it("reads a GitLab merge request, and names it the way GitLab does", () => {
    expect(runLinkOf("https://gitlab.com/acme/gate/-/merge_requests/42")).toEqual({
      kind: "merge_request",
      url: "https://gitlab.com/acme/gate/-/merge_requests/42",
      label: "Merge request !42",
      host: "gitlab.com",
      repository: "acme/gate",
    });
  });

  it("keeps a group path of any depth, which is what the `/-/` separator is for", () => {
    expect(runLinkOf("https://git.example.net/org/team/sub/gate/-/pipelines/1204")).toMatchObject({
      kind: "pipeline",
      label: "Pipeline #1204",
      host: "git.example.net",
      repository: "org/team/sub/gate",
    });
  });

  it("reads a GitHub pull request and an Actions run", () => {
    expect(runLinkOf("https://github.com/acme/gate/pull/7")).toMatchObject({
      kind: "merge_request",
      label: "Pull request #7",
      repository: "acme/gate",
    });
    expect(runLinkOf("https://github.com/acme/gate/actions/runs/9911")).toMatchObject({
      kind: "pipeline",
      label: "Actions run #9911",
      url: "https://github.com/acme/gate/actions/runs/9911",
    });
  });

  it("reads Gitea's `pulls`, which is the one place it differs from GitHub", () => {
    expect(runLinkOf("https://gitea.example.org/acme/gate/pulls/3")).toMatchObject({
      kind: "merge_request",
      label: "Pull request #3",
    });
  });

  it("canonicalises a tab and an anchor down to the resource itself", () => {
    const tab = runLinkOf("https://gitlab.com/acme/gate/-/merge_requests/42/diffs#note_88");
    expect(tab?.url).toBe("https://gitlab.com/acme/gate/-/merge_requests/42");
    const checks = runLinkOf("https://github.com/acme/gate/pull/7/checks?check_run_id=1");
    expect(checks?.url).toBe("https://github.com/acme/gate/pull/7");
  });

  it("shortens a commit sha to the seven characters anyone reads", () => {
    expect(
      runLinkOf("https://github.com/acme/gate/commit/4f1c9a2b3d4e5f60718293a4b5c6d7e8f9012345"),
    ).toMatchObject({ kind: "commit", label: "Commit 4f1c9a2" });
  });

  it("refuses the URL that offers to open a merge request, which is not one", () => {
    // What `git push` prints on every push to a branch with no MR behind it.
    expect(
      runLinkOf("https://gitlab.com/acme/gate/-/merge_requests/new?source_branch=x"),
    ).toBeNull();
  });

  it("refuses anything that is not an action the run took", () => {
    expect(runLinkOf("https://github.com/acme/gate")).toBeNull();
    expect(runLinkOf("https://docs.example.com/guide/ci/pipelines/42")).toMatchObject({
      // `owner/repo/pipelines/42` is indistinguishable from the real thing by shape alone; the
      // point of the assertion is that the shape, not the host, is what decides.
      kind: "pipeline",
    });
    expect(runLinkOf("not a url")).toBeNull();
    expect(runLinkOf("ftp://example.com/acme/gate/-/merge_requests/1")).toBeNull();
  });
});

describe("runLinksIn", () => {
  it("finds a URL that a sentence put a full stop after", () => {
    const links = runLinksIn("Opened https://gitlab.com/acme/gate/-/merge_requests/42.");
    expect(links.map((l) => l.url)).toEqual(["https://gitlab.com/acme/gate/-/merge_requests/42"]);
  });

  it("finds the one `git push` prints among its remote lines", () => {
    const output = [
      "remote:",
      "remote: View merge request for feat/x:",
      "remote:   https://gitlab.com/acme/gate/-/merge_requests/42",
      "remote:",
      "To gitlab.com:acme/gate.git",
    ].join("\n");
    expect(runLinksIn(output).map((l) => l.label)).toEqual(["Merge request !42"]);
  });

  it("unwraps a markdown link and a parenthetical", () => {
    const text =
      "See [the pipeline](https://gitlab.com/acme/gate/-/pipelines/7) (https://github.com/acme/gate/pull/2)";
    expect(runLinksIn(text).map((l) => l.kind)).toEqual(["pipeline", "merge_request"]);
  });

  it("says nothing for empty and absent text", () => {
    expect(runLinksIn(null)).toEqual([]);
    expect(runLinksIn("")).toEqual([]);
  });
});

describe("orderRunLinks", () => {
  it("collapses two mentions of one resource into one link", () => {
    const links = runLinksFrom([
      "https://gitlab.com/acme/gate/-/merge_requests/42",
      "glab mr view https://gitlab.com/acme/gate/-/merge_requests/42/diffs",
    ]);
    expect(orderRunLinks(links)).toHaveLength(1);
  });

  it("puts the proposal first, then the pipeline, then the detail", () => {
    const links = runLinksFrom([
      "https://gitlab.com/acme/gate/-/issues/9",
      "https://gitlab.com/acme/gate/-/commit/abcdef1",
      "https://gitlab.com/acme/gate/-/pipelines/7",
      "https://gitlab.com/acme/gate/-/merge_requests/42",
    ]);
    expect(orderRunLinks(links).map((l) => l.kind)).toEqual([
      "merge_request",
      "pipeline",
      "commit",
      "issue",
    ]);
  });

  it("keeps the run's own order within a kind — first opened, first listed", () => {
    const links = runLinksFrom([
      "https://gitlab.com/acme/gate/-/merge_requests/42",
      "https://gitlab.com/acme/gate/-/merge_requests/7",
    ]);
    expect(orderRunLinks(links).map((l) => l.label)).toEqual([
      "Merge request !42",
      "Merge request !7",
    ]);
  });

  it("caps the list, so thirty pushed commits cannot bury the merge request", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `https://github.com/acme/gate/commit/${String(i).padStart(7, "0")}`,
    );
    const ordered = orderRunLinks(runLinksFrom([...many, "https://github.com/acme/gate/pull/1"]));
    expect(ordered).toHaveLength(12);
    expect(ordered[0]?.kind).toBe("merge_request");
  });
});
