/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { TranscriptPrunedNotice } from "./transcript-pruned-notice";

afterEach(cleanup);

describe("the transcript-removed notice (Decision 0032)", () => {
  it("says the rule removed it, what is left, and where the rule is set", () => {
    render(<TranscriptPrunedNotice at={new Date(Date.now() - 3 * 86_400_000).toISOString()} />);

    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("removed by the Workspace's history retention (3d ago)");
    expect(notice.textContent).toContain("token usage are kept");
    expect(screen.getByRole("link", { name: "History retention" }).getAttribute("href")).toBe(
      "/settings?section=history-retention",
    );
  });
});
