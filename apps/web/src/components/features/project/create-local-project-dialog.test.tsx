/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateLocalProjectDialog } from "./create-local-project-dialog";

/**
 * The local Project's whole creation flow (issue #15's reversal, applied to Projects).
 *
 * There is nothing to pick here — the only assertion worth making is that the name typed is the
 * name sent, the id it comes back with is the id the caller is handed, and a refusal from the
 * server is shown rather than swallowed.
 */

afterEach(cleanup);

const project = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "prj-new",
  integrationId: null,
  providerProjectId: null,
  source: "local",
  title: "Internal tooling",
  syncedAt: "2026-08-27T00:00:00.000Z",
  itemCount: 0,
  fields: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  ...over,
});

describe("CreateLocalProjectDialog", () => {
  it("submits the typed name to project.createLocal, and hands the id back on success", async () => {
    let received: unknown;
    renderWithTrpc(<CreateLocalProjectDialog onCreated={() => {}} />, {
      "project.createLocal": (input) => {
        received = input;
        return project({ title: (input as { title: string }).title });
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create a project" }));
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Internal tooling" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(received).toEqual({ title: "Internal tooling" }));
  });

  it("calls onCreated with the returned id", async () => {
    const created: string[] = [];
    renderWithTrpc(<CreateLocalProjectDialog onCreated={(id) => created.push(id)} />, {
      "project.createLocal": () => project({ id: "prj-abc" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Create a project" }));
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Roadmap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(created).toEqual(["prj-abc"]));
  });

  it("shows an error from the mutation rather than closing on it", async () => {
    renderWithTrpc(<CreateLocalProjectDialog onCreated={() => {}} />, {
      "project.createLocal": () => {
        throw new Error("Something went wrong.");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create a project" }));
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Roadmap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Something went wrong.")).toBeDefined();
  });
});
