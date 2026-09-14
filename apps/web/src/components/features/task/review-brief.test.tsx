/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { ExplainErrorCode } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { ReviewBriefPanel } from "./review-brief";

/**
 * "Explain" on a criterion asks a model and is billed, so what these assert is the contract
 * that keeps that honest: nothing is asked until the button is pressed, one press is one ask
 * (a second press folds the text away, a third brings the same text back), and a refusal is a
 * sentence with a way to try again — never a wire code.
 */

afterEach(cleanup);

const BRIEF = {
  sessionId: "sess-1",
  worktreePath: null,
  criteria: [
    {
      id: "AC-1",
      text: "A pure function `assessExtraction(input)` lives in `apps/crawler/src/web-extract/`.",
      ticked: false,
      claim: { label: "assessExtraction written", state: "done", note: null },
      files: ["apps/crawler/src/web-extract/verdict.ts"],
      tests: [],
    },
  ],
  unmatched: [],
  checks: [],
};

function renderPanel(handlers: Record<string, (input: unknown) => unknown>) {
  return renderWithTrpc(
    <ReviewBriefPanel
      sessionId="sess-1"
      openItems={[]}
      verified={[]}
      onToggleVerified={() => {}}
      canVerify
    />,
    { "session.reviewBrief": () => BRIEF, ...handlers },
  );
}

describe("Explain a criterion", () => {
  it("asks only on the press, shows the reading under the criterion, and folds it away and back without asking again", async () => {
    let asks = 0;
    let sent: unknown = null;
    renderPanel({
      "session.explainCriterion": (input: unknown) => {
        asks += 1;
        sent = input;
        return {
          criterionId: "AC-1",
          text: "**What it means** — the crawler judges each article it fetched.",
          model: "claude-opus-5",
          cached: false,
        };
      },
    });

    const explain = await screen.findByRole("button", { name: "Explain AC-1" });
    // Nothing is asked for a button nobody pressed: it is billed.
    expect(asks).toBe(0);
    expect(screen.queryByText(/judges each article/)).toBeNull();

    fireEvent.click(explain);
    expect(await screen.findByText(/judges each article/)).toBeDefined();
    expect(asks).toBe(1);
    // The reader's language travels with the ask; the criterion's identifier is the key.
    expect(sent).toMatchObject({ sessionId: "sess-1", criterionId: "AC-1" });
    // Said under the text: who wrote it, and that it is not part of the record.
    expect(screen.getByText(/by claude-opus-5/).textContent).toContain("not part of the record");

    // Fold away, bring back: one ask in all.
    fireEvent.click(screen.getByRole("button", { name: "Hide the explanation of AC-1" }));
    expect(screen.queryByText(/judges each article/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Explain AC-1" }));
    expect(await screen.findByText(/judges each article/)).toBeDefined();
    expect(asks).toBe(1);
  });

  it("says a refusal in words, with a way to try again", async () => {
    let asks = 0;
    renderPanel({
      "session.explainCriterion": () => {
        asks += 1;
        if (asks === 1) throw new Error(ExplainErrorCode.NoCredential);
        return {
          criterionId: "AC-1",
          text: "Second time lucky.",
          model: "claude-opus-5",
          cached: false,
        };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Explain AC-1" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No API key");
    expect(alert.textContent).not.toContain(ExplainErrorCode.NoCredential);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Second time lucky.")).toBeDefined());
  });
});
