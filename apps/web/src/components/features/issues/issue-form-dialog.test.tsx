/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { IssueDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { IssueFormDialog } from "./issue-form-dialog";

/**
 * Create/edit Issue dialog (issue #15 reversal). Covers: create sends title/description/
 * repositoryId/labels; editing a local Issue re-submits changed fields; editing an imported
 * Issue disables and never sends title/description; the label control branches between the
 * fetched checkbox list and the free-text tag input on the selected Repository's `integrationId`.
 */

const localRepo = {
  id: "repo-local",
  name: "gate-firmware",
  source: "local_path",
  location: "/srv/repos/gate",
  integrationId: null,
  externalFullName: null,
  setupFilePatterns: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const linkedRepo = {
  id: "repo-linked",
  name: "gate-control",
  source: "remote_url",
  location: "https://github.com/acme/gate-control.git",
  integrationId: "int-1",
  externalFullName: "acme/gate-control",
  setupFilePatterns: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function baseHandlers(over: Record<string, (input: unknown) => unknown> = {}) {
  return {
    "repository.list": () => ({ items: [localRepo, linkedRepo], nextCursor: null }),
    "repository.listLabels": () => [
      { name: "bug", color: "#d73a4a", description: null },
      { name: "enhancement", color: "#a2eeef", description: null },
    ],
    ...over,
  };
}

async function pick(label: string, option: string): Promise<void> {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(cleanup);

describe("IssueFormDialog — create", () => {
  it("sends title, description, repositoryId and labels typed as free text for a local Repository", async () => {
    const { log } = renderWithTrpc(
      <IssueFormDialog trigger={<button type="button">New issue</button>} />,
      baseHandlers({ "issue.create": () => ({ id: "issue-new" }) }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));

    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Gate motor stalls" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Only in cold weather" },
    });
    await pick("Repository", "gate-firmware");

    // Free-text branch — no Integration on this Repository, nothing to fetch.
    fireEvent.change(screen.getByLabelText("New label"), { target: { value: "hardware" } });
    fireEvent.keyDown(screen.getByLabelText("New label"), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.create")).toBe(true);
    });
    const sent = log.calls.find((c) => c.path === "issue.create")?.input as {
      title: string;
      description: string;
      repositoryId: string;
      labels: string[];
    };
    expect(sent.title).toBe("Gate motor stalls");
    expect(sent.description).toBe("Only in cold weather");
    expect(sent.repositoryId).toBe("repo-local");
    expect(sent.labels).toEqual(["hardware"]);
  });

  it("renders a fetched checkbox list instead of free text once a linked Repository is chosen", async () => {
    renderWithTrpc(
      <IssueFormDialog trigger={<button type="button">New issue</button>} />,
      baseHandlers(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await pick("Repository", "gate-control");

    expect(await screen.findByRole("checkbox", { name: "bug" })).toBeDefined();
    expect(screen.queryByLabelText("New label")).toBeNull();
  });

  it("tells the Owner the label fetch failed instead of claiming the repository has none", async () => {
    renderWithTrpc(
      <IssueFormDialog trigger={<button type="button">New issue</button>} />,
      baseHandlers({
        "repository.listLabels": () => {
          throw new Error("provider token expired");
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await pick("Repository", "gate-control");

    expect(await screen.findByText("Couldn't load labels from the provider.")).toBeDefined();
    // The false-confident "no labels" copy and the checkbox list are both wrong here — neither
    // should render alongside the error.
    expect(screen.queryByText("No labels on this repository yet.")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("IssueFormDialog — edit", () => {
  function localIssue(): IssueDto {
    return {
      id: "issue-1",
      title: "Original title",
      description: "Original description",
      status: "open",
      derivedStatus: "open",
      statusOverride: null,
      statusOverrideAt: null,
      taskCount: 0,
      activeTaskCount: 0,
      source: "local",
      repositoryId: "repo-local",
      externalNumber: null,
      externalUrl: null,
      externalId: null,
      externalParentId: null,
      syncedAt: null,
      labels: ["bug"],
      linkedChangeRequests: [],
      assignees: [],
      milestone: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("pre-fills and re-submits changed fields for a local Issue", async () => {
    const { log } = renderWithTrpc(
      <IssueFormDialog issue={localIssue()} trigger={<button type="button">Edit issue</button>} />,
      baseHandlers({ "issue.update": () => localIssue() }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit issue" }));

    const title = await screen.findByLabelText("Title");
    expect((title as HTMLInputElement).value).toBe("Original title");
    fireEvent.change(title, { target: { value: "Revised title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.update")).toBe(true);
    });
    const sent = log.calls.find((c) => c.path === "issue.update")?.input as {
      id: string;
      title?: string;
      description?: string;
      labels?: string[];
    };
    expect(sent.id).toBe("issue-1");
    expect(sent.title).toBe("Revised title");
    expect(sent.labels).toEqual(["bug"]);
  });

  it("disables title/description for an imported Issue and never sends them on save", async () => {
    const imported: IssueDto = { ...localIssue(), source: "github" };
    const { log } = renderWithTrpc(
      <IssueFormDialog issue={imported} trigger={<button type="button">Edit issue</button>} />,
      baseHandlers({ "issue.update": () => imported }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit issue" }));

    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const description = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(title.disabled).toBe(true);
    expect(description.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.update")).toBe(true);
    });
    const sent = log.calls.find((c) => c.path === "issue.update")?.input as {
      title?: string;
      description?: string;
      labels?: string[];
    };
    expect(sent.title).toBeUndefined();
    expect(sent.description).toBeUndefined();
    expect(sent.labels).toEqual(["bug"]);
  });
});
