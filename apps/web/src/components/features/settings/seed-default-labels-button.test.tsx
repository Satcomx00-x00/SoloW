/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { SeedDefaultLabelsButton } from "./seed-default-labels-button";

afterEach(cleanup);

describe("SeedDefaultLabelsButton", () => {
  it("renders nothing for a local repository (no provider)", () => {
    renderWithTrpc(<SeedDefaultLabelsButton provider={null} repositoryId="repo-1" />);

    expect(screen.queryByRole("button", { name: "Initialize default labels" })).toBeNull();
  });

  it("calls the mutation with the repository id on click", async () => {
    const calls: unknown[] = [];
    renderWithTrpc(<SeedDefaultLabelsButton provider="github" repositoryId="repo-1" />, {
      "repository.seedDefaultLabels": (input) => {
        calls.push(input);
        return { created: [], existing: [] };
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Initialize default labels" }));

    await waitFor(() => expect(calls).toEqual([{ repositoryId: "repo-1" }]));
  });

  it("shows the created/existing counts on success", async () => {
    renderWithTrpc(<SeedDefaultLabelsButton provider="github" repositoryId="repo-1" />, {
      "repository.seedDefaultLabels": () => ({
        created: Array.from({ length: 12 }, (_, i) => `type/${i}`),
        existing: Array.from({ length: 18 }, (_, i) => `prio/${i}`),
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Initialize default labels" }));

    await waitFor(() =>
      expect(screen.getByText("12 labels created, 18 already there")).toBeDefined(),
    );
  });

  it("shows the error message on failure", async () => {
    renderWithTrpc(<SeedDefaultLabelsButton provider="github" repositoryId="repo-1" />, {
      "repository.seedDefaultLabels": () => {
        throw new Error("This repository has no linked integration.");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Initialize default labels" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "This repository has no linked integration.",
      ),
    );
  });
});
