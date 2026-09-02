/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRelativeAge } from "./use-relative-age";

/**
 * The assertion this file exists for is that the age *keeps* being true.
 *
 * A rendered relative time is computed during render, so on a surface that stops re-rendering it
 * freezes — a status bar that said "synced 1m ago" long after it was one minute. That was a real
 * defect, found by watching the bar rather than by any test, which is why there is one now.
 *
 * The tick interval is passed in short: what is under test is that a tick re-renders, not the
 * thirty seconds the bar happens to use.
 */

afterEach(cleanup);

function Age({ iso }: { iso: string | null }) {
  const age = useRelativeAge(iso, 20);
  return <span data-testid="age">{age ?? "never"}</span>;
}

describe("useRelativeAge", () => {
  it("re-renders as time passes instead of freezing at the first render", async () => {
    /*
     * Mounted a few hundred milliseconds short of a rounding boundary, so the label is due to
     * change almost immediately. Waiting out a real minute would make this a test of the clock;
     * this way it is a test of the tick, and it finishes in under a second.
     *
     * 89.4s rounds to 1 minute. Six hundred milliseconds later it rounds to 2.
     */
    const iso = new Date(Date.now() - 89_400).toISOString();
    render(<Age iso={iso} />);
    expect(screen.getByTestId("age").textContent).toBe("1m ago");

    // Nothing here re-renders the component; only the hook's own tick can move this on. Before
    // the tick existed this assertion failed, which is the defect it was written for.
    await waitFor(() => expect(screen.getByTestId("age").textContent).toBe("2m ago"), {
      timeout: 5_000,
    });
  }, 10_000);

  it("renders nothing to keep current when there is no timestamp", () => {
    render(<Age iso={null} />);
    expect(screen.getByTestId("age").textContent).toBe("never");
  });
});
