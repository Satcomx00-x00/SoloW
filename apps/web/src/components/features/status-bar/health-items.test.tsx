/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { AttentionItemDto, SystemHealthDto } from "@solow/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AppContextProvider } from "@/lib/app-context";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { preferenceFixture } from "./preference-fixture";
import { StatusBar } from "./status-bar";

/**
 * The bar's health segments (FINDINGS F3), through the bar the shell mounts: what it says when
 * the services are fine, when one is down, and which runs need a person.
 */

const NOW = new Date().toISOString();
const HEALTHY: SystemHealthDto = {
  orchestrator: { state: "ok", detail: null },
  engine: { state: "ok", detail: null },
  checkedAt: NOW,
};

function item(overrides: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    taskId: "t-1",
    title: "Fix the login form",
    state: "failed",
    failureReason: "fail",
    kind: "failed",
    cause: "failed",
    since: NOW,
    ...overrides,
  };
}

let sockets: FakeSocket[] = [];
let restore: () => void = () => {};

afterEach(() => {
  restore();
  cleanup();
});

function renderBar(handlers: Record<string, (input: unknown) => unknown>) {
  ({ sockets, restore } = installFakeWebSocket());
  return renderWithTrpc(
    <AppContextProvider value={{ identity: null }}>
      <WorkspaceEventsProvider>
        <StatusBar />
      </WorkspaceEventsProvider>
    </AppContextProvider>,
    {
      "task.list": () => ({ items: [], nextCursor: null }),
      "stream.ticket": () => ({ url: "ws://hub.test/stream?ticket=t" }),
      "workspace.syncStatus": () => ({
        repositories: 0,
        syncedAt: null,
        stale: 0,
        staleReason: null,
      }),
      "health.attention": () => ({ items: [], truncated: false, recheckAt: null }),
      ...preferenceFixture().handlers,
      ...handlers,
    },
  );
}

describe("the health segment", () => {
  it("reads healthy when both services answer", async () => {
    renderBar({ "health.status": () => HEALTHY });
    expect(await screen.findByText("healthy")).toBeDefined();
  });

  it("says the engine is down, and what that means, in plain words", async () => {
    renderBar({
      "health.status": () => ({
        ...HEALTHY,
        engine: { state: "unreachable", detail: "engine refused the connection" },
      }),
    });

    fireEvent.click(await screen.findByText("engine down"));

    expect(await screen.findByText("Runs are affected")).toBeDefined();
    expect(screen.getByText(/New runs will not start/)).toBeDefined();
    expect(screen.getByText(/engine refused the connection/)).toBeDefined();
  });

  it("says the orchestrator is down without claiming anything about the engine", async () => {
    renderBar({
      "health.status": () => ({
        orchestrator: { state: "unreachable", detail: "no answer" },
        engine: { state: "unknown", detail: null },
        checkedAt: NOW,
      }),
    });

    fireEvent.click(await screen.findByText("orchestrator down"));

    expect(await screen.findByText(/only the orchestrator can reach it/)).toBeDefined();
  });

  it("asks again when the hub connection drops", async () => {
    let asked = 0;
    const { log } = renderBar({
      "health.status": () => {
        asked += 1;
        return HEALTHY;
      },
    });
    await screen.findByText("healthy");
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const before = asked;

    act(() => sockets[0]?.drop());

    await waitFor(() => expect(asked).toBeGreaterThan(before));
    expect(log.calls.filter((c) => c.path === "health.status").length).toBeGreaterThan(1);
  });

  it("stays off the bar when health cannot be read at all", async () => {
    renderBar({
      "health.status": () => {
        throw new Error("UNAUTHORIZED");
      },
    });
    await screen.findByText("0 tasks");
    expect(screen.queryByText("healthy")).toBeNull();
  });
});

describe("the needs-attention segment", () => {
  it("is absent when nothing needs attention", async () => {
    renderBar({ "health.status": () => HEALTHY });
    await screen.findByText("healthy");
    expect(screen.queryByText(/attention/)).toBeNull();
  });

  it("counts failed and stuck runs, and lists each with why and a link to it", async () => {
    renderBar({
      "health.status": () => HEALTHY,
      "health.attention": () => ({
        items: [
          item({}),
          item({
            taskId: "t-2",
            title: "Upgrade the parser",
            state: "running",
            failureReason: null,
            kind: "stuck",
            cause: "run_silent",
          }),
        ],
        truncated: false,
        recheckAt: null,
      }),
    });

    const trigger = await screen.findByText(/2 need attention/);
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });

    const failed = await screen.findByText("Fix the login form");
    expect(failed.closest("a")?.getAttribute("href")).toBe("/task/t-1");
    expect(screen.getByText(/Run failed ·/)).toBeDefined();
    const stuck = screen.getByText("Upgrade the parser");
    expect(stuck.closest("a")?.getAttribute("href")).toBe("/task/t-2");
    expect(screen.getByText(/No activity ·/)).toBeDefined();
  });

  it("uses the singular for one", async () => {
    renderBar({
      "health.status": () => HEALTHY,
      "health.attention": () => ({ items: [item({})], truncated: false, recheckAt: null }),
    });
    expect(await screen.findByText(/1 needs attention/)).toBeDefined();
  });
});
