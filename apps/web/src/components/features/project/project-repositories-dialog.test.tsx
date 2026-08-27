/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { ProjectRepositoriesDialog } from "./project-repositories-dialog";

/**
 * Managing a local Project's membership (issue #15's reversal, applied to Projects).
 *
 * Two things matter here: attaching an unregistered Repository sends the right pair, and
 * detaching asks first only when there is something to lose — an empty Repository leaves no row
 * behind, so confirming that would be friction with no purpose.
 */

afterEach(cleanup);

const attachedRepo = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "pr-1",
  repositoryId: "repo-1",
  repositoryName: "gate-firmware",
  issueCount: 3,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  ...over,
});

const repoRow = (id: string, name: string) => ({
  id,
  name,
  source: "local_path",
  location: "/srv/repos/x",
  integrationId: null,
  externalFullName: null,
  setupFilePatterns: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
});

async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "Repositories" }));
}

describe("ProjectRepositoriesDialog", () => {
  it("lists attached repositories with their issue counts", async () => {
    renderWithTrpc(
      <ProjectRepositoriesDialog
        projectId="prj-1"
        trigger={<button type="button">Repositories</button>}
      />,
      {
        "project.repositories": () => [attachedRepo()],
        "repository.list": () => ({
          items: [repoRow("repo-1", "gate-firmware")],
          nextCursor: null,
        }),
      },
    );

    await open();

    expect(await screen.findByText("gate-firmware")).toBeDefined();
    expect(screen.getByText("3 issues")).toBeDefined();
  });

  it("attaching an unattached repository calls attachRepository with the project and repository ids", async () => {
    const calls: unknown[] = [];
    renderWithTrpc(
      <ProjectRepositoriesDialog
        projectId="prj-1"
        trigger={<button type="button">Repositories</button>}
      />,
      {
        "project.repositories": () => [],
        "repository.list": () => ({
          items: [repoRow("repo-2", "gate-control")],
          nextCursor: null,
        }),
        "project.attachRepository": (input) => {
          calls.push(input);
          return attachedRepo({
            repositoryId: "repo-2",
            repositoryName: "gate-control",
            issueCount: 0,
          });
        },
      },
    );

    await open();
    fireEvent.click(await screen.findByRole("combobox", { name: "Attach a repository" }));
    fireEvent.click(await screen.findByRole("option", { name: "gate-control" }));

    await waitFor(() => expect(calls).toEqual([{ projectId: "prj-1", repositoryId: "repo-2" }]));
  });

  it("detaching a repository with zero issues needs no confirmation", async () => {
    const calls: unknown[] = [];
    renderWithTrpc(
      <ProjectRepositoriesDialog
        projectId="prj-1"
        trigger={<button type="button">Repositories</button>}
      />,
      {
        "project.repositories": () => [attachedRepo({ issueCount: 0 })],
        "repository.list": () => ({
          items: [repoRow("repo-1", "gate-firmware")],
          nextCursor: null,
        }),
        "project.detachRepository": (input) => {
          calls.push(input);
          return { projectId: "prj-1", repositoryId: "repo-1" };
        },
      },
    );

    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Detach gate-firmware" }));

    // No confirmation dialog should ever appear for a zero-issue detach.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(calls).toEqual([{ projectId: "prj-1", repositoryId: "repo-1" }]));
  });

  it("detaching a repository with issues asks for confirmation before the mutation fires", async () => {
    const calls: unknown[] = [];
    renderWithTrpc(
      <ProjectRepositoriesDialog
        projectId="prj-1"
        trigger={<button type="button">Repositories</button>}
      />,
      {
        "project.repositories": () => [attachedRepo({ issueCount: 3 })],
        "repository.list": () => ({
          items: [repoRow("repo-1", "gate-firmware")],
          nextCursor: null,
        }),
        "project.detachRepository": (input) => {
          calls.push(input);
          return { projectId: "prj-1", repositoryId: "repo-1" };
        },
      },
    );

    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Detach gate-firmware" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(calls).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(calls).toEqual([{ projectId: "prj-1", repositoryId: "repo-1" }]));
  });
});
