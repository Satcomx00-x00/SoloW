/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { IssueDto } from "@gatecontrol/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The Issues list and its filters (spec F01 FR-2).
 *
 * The filters live in the URL, which is what makes a narrowed list shareable and reloadable —
 * so these tests drive the URL and assert on what `issue.list` was asked for, rather than on
 * internal state that no user or link can reach.
 *
 * The `next/navigation` stub is stateful for the same reason: `useSearchParams` is the input and
 * `router.replace` is the output, and a test that could not see both would be testing the
 * filters with the URL taken out. It carries every hook app code under this directory reads,
 * because `mock.module` is process-wide — issue-detail.test.tsx documents that hazard at length.
 */
let url = new URLSearchParams();
const replaced: string[] = [];

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => replaced.push(href),
    replace: (href: string) => replaced.push(href),
    refresh: () => {},
  }),
  usePathname: () => "/issues",
  useSearchParams: () => url,
  useParams: () => ({}),
}));

const { IssuesView, readFilters, toSearchParams } = await import("./issues-view");

function issueWith(overrides: Partial<IssueDto> = {}): IssueDto {
  return {
    id: "issue-1",
    title: "Keypad backlight flickers",
    description: "only at dusk",
    status: "open",
    derivedStatus: "open",
    statusOverride: null,
    statusOverrideAt: null,
    taskCount: 0,
    activeTaskCount: 0,
    source: "local",
    repositoryId: null,
    externalNumber: null,
    externalUrl: null,
    syncedAt: null,
    labels: ["hardware"],
    linkedChangeRequests: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Point the stubbed URL at `search` before rendering. */
function at(search: string): void {
  url = new URLSearchParams(search);
  replaced.length = 0;
}

afterEach(cleanup);

describe("issue filters ↔ URL", () => {
  it("reads every filter out of the query string", () => {
    const filters = readFilters(
      new URLSearchParams("status=open&q=latch&label=hardware&label=ui&source=github"),
    );
    expect(filters).toEqual({
      status: "open",
      query: "latch",
      labels: ["hardware", "ui"],
      source: "github",
    });
  });

  it("ignores a status, or a source that is not a provider id at all", () => {
    // A hand-edited URL is untrusted input like any other — it narrows to nothing rather than
    // reaching the server as a value the input schema would reject.
    const filters = readFilters(new URLSearchParams("status=urgent&source=NOT A PROVIDER"));
    expect(filters.status).toBeNull();
    expect(filters.source).toBeNull();
  });

  it("keeps a provider id this build has never heard of", () => {
    // Validated against the id *grammar*, not a list of three. Decision 0016 opened the source
    // union precisely so an unfamiliar provider costs a badge rather than a feature (F21 FR-7):
    // a Workspace with a Gitea integration must be able to filter by it, and hardcoding the
    // known set here is the ninth of the eight branches F21 removed.
    expect(readFilters(new URLSearchParams("source=gitea")).source).toBe("gitea");
    expect(readFilters(new URLSearchParams("source=jira")).source).toBe("jira");
    expect(readFilters(new URLSearchParams("source=local")).source).toBe("local");
  });

  it("round-trips back to a query string, and drops what is not set", () => {
    const filters = readFilters(new URLSearchParams("q=latch&label=hardware&label=ui"));
    expect(toSearchParams(filters)).toBe("/issues?q=latch&label=hardware&label=ui");
    expect(toSearchParams({ status: null, query: "", labels: [], source: null })).toBe("/issues");
  });
});

describe("IssuesView", () => {
  it("asks issue.list for exactly the filters the URL names", async () => {
    at("status=open&q=latch&label=hardware&source=github");
    const { log } = renderWithTrpc(<IssuesView />, {
      "issue.list": () => [issueWith()],
      "issue.labels": () => ["hardware", "ui"],
    });

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "issue.list");
      expect(call?.input).toEqual({
        status: "open",
        query: "latch",
        source: "github",
        labels: ["hardware"],
      });
    });
  });

  it("sends no filter keys at all when the URL names none", async () => {
    at("");
    const { log } = renderWithTrpc(<IssuesView />, {
      "issue.list": () => [issueWith()],
      "issue.labels": () => [],
    });

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "issue.list");
      expect(call?.input).toEqual({});
    });
  });

  it("offers the Workspace's whole label vocabulary, not the labels of what survived the filter", async () => {
    at("label=hardware");
    renderWithTrpc(<IssuesView />, {
      // The one visible Issue carries "hardware" alone; "ui" must still be offered, or choosing
      // a label would delete every other option from the menu that offered it.
      "issue.list": () => [issueWith()],
      "issue.labels": () => ["hardware", "ui"],
    });

    const trigger = await screen.findByRole("button", { name: /Labels/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("menuitemcheckbox", { name: "ui" })).toBeTruthy();
  });

  it("hides the label filter entirely when the Workspace has no labels", async () => {
    at("");
    renderWithTrpc(<IssuesView />, {
      "issue.list": () => [issueWith({ labels: [] })],
      "issue.labels": () => [],
    });

    await screen.findByText("Keypad backlight flickers");
    expect(screen.queryByRole("button", { name: /Labels/ })).toBeNull();
  });

  it("clears search, labels and source — and leaves the status tab alone", async () => {
    at("status=open&q=latch&label=hardware&source=github");
    renderWithTrpc(<IssuesView />, {
      "issue.list": () => [issueWith()],
      "issue.labels": () => ["hardware"],
    });

    fireEvent.click(await screen.findByRole("button", { name: /Clear/ }));
    await waitFor(() => expect(replaced.at(-1)).toBe("/issues?status=open"));
  });

  it("pushes a typed search into the URL once, after the typing stops", async () => {
    at("");
    renderWithTrpc(<IssuesView />, {
      "issue.list": () => [issueWith()],
      "issue.labels": () => [],
    });

    const box = await screen.findByLabelText("Search issues");
    fireEvent.change(box, { target: { value: "lat" } });
    fireEvent.change(box, { target: { value: "latch" } });

    // Debounced: a replace per keystroke would re-run the query mid-word.
    expect(replaced).toEqual([]);
    await waitFor(() => expect(replaced).toEqual(["/issues?q=latch"]), { timeout: 2000 });
  });

  it("says the filters are what is hiding everything, not that there is nothing", async () => {
    at("q=nothing-matches-this");
    renderWithTrpc(<IssuesView />, {
      "issue.list": () => [],
      "issue.labels": () => ["hardware"],
    });

    expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
  });

  it("still says there is nothing when the Workspace really is empty", async () => {
    at("");
    renderWithTrpc(<IssuesView />, { "issue.list": () => [], "issue.labels": () => [] });

    expect(await screen.findByText("No issues yet")).toBeTruthy();
  });
});
