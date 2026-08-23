/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateTaskDialog } from "./create-task-dialog";

/**
 * The Task-creation Issue picker, filtered by the chosen Repository (user report: "the issue
 * picker in Task creation should auto-populate from the selected Repository").
 */

const handlers = {
  "issue.list": () => [
    {
      id: "issue-1",
      title: "Ship it",
      description: "The upload endpoint rejects files over 2 MB.",
      status: "open",
      taskCount: 0,
      labels: ["bug"],
      source: "github",
      externalNumber: 42,
      externalUrl: "https://github.com/acme/api/issues/42",
    },
  ],
  "profile.agent.list": () => [{ id: "agent-1", name: "Claude" }],
  "profile.executor.list": () => [{ id: "exec-1", name: "Local" }],
  "repository.list": () => [
    { id: "repo-1", name: "api", source: "local_path", location: "/srv/api" },
    { id: "repo-2", name: "shared-lib", source: "local_path", location: "/srv/lib" },
  ],
  "task.list": () => [],
};

async function pick(label: string, option: string): Promise<void> {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(cleanup);

describe("CreateTaskDialog — Issue picker filtered by Repository", () => {
  it("re-queries issue.list with the chosen Repository's id once one is picked", async () => {
    const { log } = renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    // Unfiltered on first open — nothing chosen yet.
    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.list")).toBe(true);
    });

    await pick("Repository", "api");

    await waitFor(() => {
      const filtered = log.calls.filter(
        (c) => c.path === "issue.list" && (c.input as { repositoryId?: string }).repositoryId,
      );
      expect(filtered.length).toBeGreaterThan(0);
    });
    const last = log.calls.filter((c) => c.path === "issue.list").at(-1);
    expect(last).toBeDefined();
    expect((last?.input as { repositoryId?: string } | undefined)?.repositoryId).toBe("repo-1");
  });

  it("clears a previously chosen Issue when the Repository changes underneath it", async () => {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    await pick("Repository", "api");
    await pick("Issue", "Ship it");
    expect((await screen.findByRole("combobox", { name: "Issue" })).textContent).toContain(
      "Ship it",
    );

    await pick("Repository", "shared-lib");

    // The Issue field reverts to its placeholder — the previous pick did not silently ride along
    // onto a Repository it was never chosen for.
    expect((await screen.findByRole("combobox", { name: "Issue" })).textContent).not.toContain(
      "Ship it",
    );
  });

  it("labels the Issue picker's placeholder to say a Repository comes first", async () => {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    expect(screen.getByText("Select a repository first")).toBeDefined();
  });
});

/**
 * What the Owner can see of the Issue they are launching an agent against.
 *
 * The picker is a Select, so it showed one truncated line and nothing else: the brief for a run
 * was being chosen from a fragment of itself. These pin the whole Issue being on screen, and the
 * Task taking its name from it without overwriting a name a person typed.
 */
describe("CreateTaskDialog — the chosen Issue", () => {
  async function openAndPick(): Promise<void> {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    await pick("Repository", "api");
    await pick("Issue", "Ship it");
  }

  it("shows the body, the labels and the link back to the provider", async () => {
    await openAndPick();

    const preview = await screen.findByRole("region", { name: "Selected issue" });
    expect(preview.textContent).toContain("The upload endpoint rejects files over 2 MB.");
    expect(preview.textContent).toContain("bug");
    expect(preview.textContent).toContain("#42");
    expect(preview.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/api/issues/42",
    );
  });

  it("names the task after the issue", async () => {
    await openAndPick();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Ship it");
  });

  it("leaves a title the owner typed alone", async () => {
    // Picking an Issue after writing your own title must not throw the title away — the whole
    // point of an editable field is that the edit survives.
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "My own name" } });

    await pick("Repository", "api");
    await pick("Issue", "Ship it");

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My own name");
  });
});
