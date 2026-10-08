/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { CommonErrorCode, type OutcomesDto, type OutcomesSpendDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/outcomes",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { OutcomesView } = await import("./outcomes-view");

/**
 * The Outcomes page: each figure is shown with what it counts, the gaps in coverage are said out
 * loud, and a Workspace with nothing to measure gets an empty state rather than a wall of zeros.
 */

afterEach(cleanup);

function spend(over: Partial<OutcomesSpendDto> = {}): OutcomesSpendDto {
  return {
    turns: 0,
    unreportedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    meteredTurns: 0,
    unpricedTurns: 0,
    meteredCostUsd: 0,
    ...over,
  };
}

function outcomes(over: Partial<OutcomesDto> = {}): OutcomesDto {
  return {
    window: { weeks: 4, from: "2026-09-14T00:00:00.000Z", to: "2026-10-08T12:00:00.000Z" },
    shipped: {
      total: 0,
      asPullRequest: 0,
      localCommit: 0,
      approvedNotDelivered: 0,
      weeks: ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"].map((weekStart) => ({
        weekStart,
        shipped: 0,
        asPullRequest: 0,
      })),
    },
    approval: {
      runTasks: 0,
      inFlight: 0,
      settled: 0,
      approved: 0,
      approvedWithinTwo: 0,
      approvalRate: null,
      withinTwoRate: null,
      meanAttempts: null,
      attempts: [1, 2, 3, 4].map((attempts) => ({ attempts, orMore: attempts === 4, tasks: 0 })),
    },
    spend: { total: spend(), tasks: 0, byBillingMode: [], byProfile: [], topTasks: [] },
    firstPullRequest: {
      workspaceCreatedAt: "2026-09-01T09:00:00.000Z",
      shippedAt: null,
      elapsedMs: null,
    },
    ...over,
  };
}

const busy = outcomes({
  shipped: {
    total: 3,
    asPullRequest: 2,
    localCommit: 1,
    approvedNotDelivered: 1,
    weeks: [
      { weekStart: "2026-09-14", shipped: 1, asPullRequest: 1 },
      { weekStart: "2026-09-21", shipped: 0, asPullRequest: 0 },
      { weekStart: "2026-09-28", shipped: 0, asPullRequest: 0 },
      { weekStart: "2026-10-05", shipped: 2, asPullRequest: 1 },
    ],
  },
  approval: {
    runTasks: 6,
    inFlight: 1,
    settled: 5,
    approved: 4,
    approvedWithinTwo: 3,
    approvalRate: 0.8,
    withinTwoRate: 0.6,
    meanAttempts: 2,
    attempts: [
      { attempts: 1, orMore: false, tasks: 2 },
      { attempts: 2, orMore: false, tasks: 1 },
      { attempts: 3, orMore: false, tasks: 0 },
      { attempts: 4, orMore: true, tasks: 1 },
    ],
  },
  spend: {
    total: spend({
      turns: 5,
      unreportedTurns: 1,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      meteredTurns: 3,
      unpricedTurns: 1,
      meteredCostUsd: 4.5,
    }),
    tasks: 2,
    byBillingMode: [
      { ...spend({ turns: 1, inputTokens: 10 }), authMode: "subscription" },
      {
        ...spend({ turns: 4, inputTokens: 999_990, meteredTurns: 3, meteredCostUsd: 4.5 }),
        authMode: "api_key",
      },
    ],
    byProfile: [
      {
        ...spend({ turns: 4, inputTokens: 999_990, meteredTurns: 3, meteredCostUsd: 4.5 }),
        profileId: "p-1",
        name: "claude-api",
        authMode: "api_key",
        tasks: 1,
      },
      {
        ...spend({ turns: 1, inputTokens: 10 }),
        profileId: "p-2",
        name: "claude-max",
        authMode: "subscription",
        tasks: 1,
      },
    ],
    topTasks: [
      {
        ...spend({ turns: 4, inputTokens: 999_990, meteredTurns: 3, meteredCostUsd: 4.5 }),
        taskId: "task-1",
        title: "Fix the latch",
        state: "done",
      },
    ],
  },
  firstPullRequest: {
    workspaceCreatedAt: "2026-09-01T09:00:00.000Z",
    shippedAt: "2026-09-03T09:00:00.000Z",
    elapsedMs: 2 * 24 * 3600 * 1000,
  },
});

describe("OutcomesView", () => {
  it("shows each figure beside the sentence that defines it", async () => {
    renderWithTrpc(<OutcomesView />, { "outcomes.get": () => busy });

    const shipped = await screen.findByRole("region", { name: "Shipped" });
    expect(shipped.textContent).toContain("Done, a person approved it");
    expect(shipped.textContent).toContain("1 approved in this window was committed but not");
    const weeks = within(shipped).getByRole("list", { name: "Shipped per week" });
    expect(within(weeks).getAllByRole("listitem")).toHaveLength(4);

    const approval = screen.getByRole("region", { name: "Reaching approval" });
    expect(approval.textContent).toContain("60%");
    expect(approval.textContent).toContain("approved within two attempts (3 of 5)");
    expect(approval.textContent).toContain("run-to-approval rate (4 of 5)");
    expect(approval.textContent).toContain("1 still running, parked or waiting for review");

    const spendRegion = screen.getByRole("region", { name: "Spend" });
    expect(spendRegion.textContent).toContain("$4.50");
    expect(spendRegion.textContent).toContain("1 turn reported no usage");
    expect(spendRegion.textContent).toContain("does not know");
    const profiles = within(spendRegion).getByRole("table", { name: "By harness profile" });
    expect(within(profiles).getByRole("rowheader", { name: /claude-max/ })).toBeDefined();
    expect(profiles.textContent).toContain("Subscription");
    expect(
      within(spendRegion).getByRole("link", { name: "Fix the latch" }).getAttribute("href"),
    ).toBe("/task/task-1");

    expect(screen.getByText("2 days")).toBeDefined();
  });

  it("reads the window the person picks", async () => {
    const { log } = renderWithTrpc(<OutcomesView />, { "outcomes.get": () => busy });
    await screen.findByRole("region", { name: "Shipped" });

    fireEvent.click(screen.getByRole("button", { name: "4 weeks" }));
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.path === "outcomes.get" && (c.input as { weeks: number }).weeks === 4,
        ),
      ).toBe(true),
    );
    expect(log.calls.find((c) => c.path === "outcomes.get")?.input).toEqual({ weeks: 12 });
  });

  it("says there is nothing to measure rather than showing a page of zeros", async () => {
    renderWithTrpc(<OutcomesView />, { "outcomes.get": () => outcomes() });
    expect(await screen.findByText("Nothing to measure in the last 12 weeks")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Shipped" })).toBeNull();
    expect(screen.getByText(/No task has shipped as a pull request yet/)).toBeDefined();
  });

  it("explains a switched-off page instead of failing", async () => {
    renderWithTrpc(<OutcomesView />, {
      "outcomes.get": () => {
        throw new Error(CommonErrorCode.FlagDisabled);
      },
    });
    expect(await screen.findByText("Outcomes are not enabled here")).toBeDefined();
    expect(screen.getByText("bun run flag enable ff-outcomes")).toBeDefined();
  });

  it("names any other failure", async () => {
    renderWithTrpc(<OutcomesView />, {
      "outcomes.get": () => {
        throw new Error("boom");
      },
    });
    expect(await screen.findByText("Failed to load outcomes")).toBeDefined();
  });
});
