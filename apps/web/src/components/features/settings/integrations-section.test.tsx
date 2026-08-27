/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { IntegrationsSection } from "./integrations-section";

/**
 * Importing a repository from an Integration, and disconnecting one (spec F12).
 *
 * The import assertions pin the workflow change: a repository is created from a *pick*, with no
 * local clone named first. The disconnect ones cover the opposite direction — it throws away data
 * the provider can never be asked for again, so the user has to be told that before it happens,
 * in terms of their own repositories, and the click that opens the confirmation must not itself
 * be the action.
 */

afterEach(cleanup);

const TIMESTAMPS = { createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" };

const GITHUB = {
  id: "int-1",
  provider: "github",
  secretId: "sec-1",
  baseUrl: null,
  writeBackEnabled: false,
  ...TIMESTAMPS,
};

const LINKED_REPO = {
  id: "repo-1",
  name: "solow",
  source: "local_path",
  location: "/srv/repos/solow",
  integrationId: "int-1",
  externalFullName: "acme/gate",
  ...TIMESTAMPS,
};

/** The three queries the section makes on mount, with no external-repository lookup needed. */
function baseHandlers(repos: unknown[] = []) {
  return {
    "integration.list": () => [GITHUB],
    "secret.list": () => [],
    "repository.list": () => ({ items: repos, nextCursor: null }),
  };
}

const EXTERNAL_REPO = {
  fullName: "acme/gate",
  name: "gate",
  description: "the gate",
  defaultBranch: "main",
  isPrivate: true,
  url: "https://github.com/acme/gate",
  cloneUrl: "https://github.com/acme/gate.git",
  alreadyImported: false,
};

/**
 * Open a select, once it is actually openable. The repository picker stays disabled while its
 * query is in flight, and a click on a disabled trigger is silently nothing — which shows up as
 * a missing option much later, so the wait belongs here rather than in each test.
 */
async function openSelect(name: string) {
  const trigger = await screen.findByRole("combobox", { name });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  fireEvent.click(trigger);
}

/** Pick an option out of a select by opening its trigger and clicking the option. */
async function pick(triggerName: string, optionName: string | RegExp) {
  await openSelect(triggerName);
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("IntegrationsSection — importing", () => {
  it("creates a Repository from a picked provider repo, with no local repository named first", async () => {
    const imported: unknown[] = [];
    renderWithTrpc(<IntegrationsSection />, {
      ...baseHandlers(),
      "integration.listExternalRepositories": () => [EXTERNAL_REPO],
      "integration.importRepository": (input) => {
        imported.push(input);
        return { ...LINKED_REPO, source: "remote_url", location: EXTERNAL_REPO.cloneUrl };
      },
    });

    await pick("Integration", "github");
    await pick("Repository", /acme\/gate/);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // The whole input: an Integration and a repository on it. No repositoryId, because there is
    // no local Repository to have connected first — that is the point of the change.
    await waitFor(() =>
      expect(imported).toEqual([{ integrationId: "int-1", externalFullName: "acme/gate" }]),
    );
  });

  it("does not offer a repository that is already imported", async () => {
    renderWithTrpc(<IntegrationsSection />, {
      ...baseHandlers(),
      "integration.listExternalRepositories": () => [{ ...EXTERNAL_REPO, alreadyImported: true }],
    });

    await pick("Integration", "github");
    await openSelect("Repository");
    const option = await screen.findByRole("option", { name: /acme\/gate/ });
    // Flagged rather than hidden: someone looking for a repository they imported last week has
    // to find it marked, not conclude the list is broken.
    expect(option.textContent).toContain("already imported");
    expect(option.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers nothing to import until an Integration is chosen", async () => {
    renderWithTrpc(<IntegrationsSection />, {
      ...baseHandlers(),
      // Deliberately absent: the query authenticates against a specific Integration's token, so
      // asking before one is chosen would be a call the harness fails on.
    });

    const repoSelect = await screen.findByRole("combobox", { name: "Repository" });
    expect(repoSelect.hasAttribute("disabled")).toBe(true);
    expect(repoSelect.textContent).toContain("Select an integration first");
  });

  it("surfaces a failed import instead of appearing to succeed", async () => {
    renderWithTrpc(<IntegrationsSection />, {
      ...baseHandlers(),
      "integration.listExternalRepositories": () => [EXTERNAL_REPO],
      "integration.importRepository": () => {
        throw new Error("NOT_FOUND");
      },
    });

    await pick("Integration", "github");
    await pick("Repository", /acme\/gate/);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("NOT_FOUND");
    });
  });
});

describe("IntegrationsSection", () => {
  it("disconnects only after the Owner confirms it", async () => {
    const disconnected: unknown[] = [];
    renderWithTrpc(<IntegrationsSection />, {
      ...baseHandlers(),
      "integration.delete": (input) => {
        disconnected.push(input);
        return {
          id: "int-1",
          repositoriesUnlinked: 0,
          branchesDeleted: 0,
          changeRequestsDeleted: 0,
          issuesDetached: 0,
        };
      },
    });

    const trigger = await screen.findByRole("button", {
      name: "Disconnect the github integration",
    });
    fireEvent.click(trigger);
    expect(disconnected).toHaveLength(0);

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnected).toEqual([{ id: "int-1" }]));
  });

  it("names the repositories that will be unlinked, and what survives", async () => {
    renderWithTrpc(<IntegrationsSection />, baseHandlers([LINKED_REPO]));

    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect the github integration" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const description = dialog.textContent ?? "";

    // The consequence is stated in the user's own nouns, not as a count of rows.
    expect(description).toContain("1 linked repository (solow) will be unlinked");
    expect(description).toContain("branches and change requests synced from it are removed");
    // And the part that is *not* destroyed is said explicitly — otherwise a cautious user
    // assumes their imported work goes with it and never disconnects at all.
    expect(description).toContain("Issues already imported are kept");
  });

  it("says so plainly when nothing is linked to the Integration", async () => {
    renderWithTrpc(<IntegrationsSection />, baseHandlers());

    expect(await screen.findByText("no linked repositories")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect the github integration" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("No repositories are linked to it.");
  });

  it("surfaces a failed disconnect instead of appearing to succeed", async () => {
    renderWithTrpc(<IntegrationsSection />, {
      ...baseHandlers(),
      "integration.delete": () => {
        throw new Error("NOT_FOUND");
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect the github integration" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("NOT_FOUND");
    });
  });
});
