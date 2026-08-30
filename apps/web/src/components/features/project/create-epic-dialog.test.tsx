/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateEpicDialog, epicDateValue } from "./create-epic-dialog";
import { epicItemState, issueItemState } from "./project-create-menu";

/**
 * Flow B of the create workflow (F23a Part 1), plus the pure gating the `＋ New` menu leans on.
 *
 * The gating is tested here rather than by driving a radix dropdown: it is a pure function, and
 * the one rule that most needs pinning — the epic entry is disabled *with a reason* when the
 * manifest says `epics: false` — is a property of that function, not of the menu's chrome.
 */

afterEach(cleanup);

const group = (over: Record<string, unknown> = {}) => ({
  integrationId: "int-1",
  externalId: "g1",
  fullPath: "acme/platform",
  name: "Platform",
  url: "https://gitlab.com/groups/acme/platform",
  ...over,
});

describe("issueItemState", () => {
  it("enables New issue when a provider-backed repository exists", () => {
    expect(issueItemState([{ integrationId: "int-1" }]).enabled).toBe(true);
  });

  it("disables it with a reason when every repository is a local path", () => {
    const state = issueItemState([{ integrationId: null }]);
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/no provider-backed repository/i);
  });
});

describe("epicItemState", () => {
  const integrations = [{ id: "int-1", provider: "gitlab" }];

  it("enables New epic when the provider's manifest declares epics", () => {
    const state = epicItemState({
      integrationId: "int-1",
      integrations,
      manifests: [{ id: "gitlab", name: "GitLab", issueCreates: { epics: true } }],
    });
    expect(state.enabled).toBe(true);
    expect(state.integrationId).toBe("int-1");
  });

  it("disables it with a reason when the manifest says epics: false", () => {
    const state = epicItemState({
      integrationId: "int-1",
      integrations,
      manifests: [{ id: "gitlab", name: "GitLab", issueCreates: { epics: false } }],
    });
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("GitLab does not support epics.");
  });

  it("disables it on a local project, which has no provider at all", () => {
    const state = epicItemState({ integrationId: null, integrations, manifests: [] });
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/no provider/i);
  });
});

describe("epicDateValue (three-state)", () => {
  const today = "2026-08-30";
  it("sends undefined for an untouched field — leave the provider's default", () => {
    expect(epicDateValue("", false, today)).toBeUndefined();
  });
  it("sends null for a field cleared on purpose", () => {
    expect(epicDateValue("", true, today)).toBeNull();
  });
  it("sends the parsed date for a fixed one", () => {
    expect(epicDateValue("2026-09-01", true, today)).toBe("2026-09-01");
  });
});

describe("CreateEpicDialog", () => {
  it("skips the 'Where' modal when only one group comes back", async () => {
    renderWithTrpc(
      <CreateEpicDialog projectId="prj-1" integrationId="int-1" open onOpenChange={() => {}} />,
      { "project.listGroups": () => [group()] },
    );

    expect(await screen.findByText("New epic · compose")).toBeDefined();
    expect(screen.getByLabelText("Title")).toBeDefined();
  });

  it("preserves the typed title across ← Back", async () => {
    renderWithTrpc(
      <CreateEpicDialog projectId="prj-1" integrationId="int-1" open onOpenChange={() => {}} />,
      {
        "project.listGroups": () => [
          group(),
          group({ externalId: "g2", fullPath: "acme/labs", name: "Labs" }),
        ],
      },
    );

    await screen.findByText("New epic · where");
    fireEvent.click(screen.getByText("acme/platform").closest("button") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("New epic · compose");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reliability" } });

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await screen.findByText("New epic · where");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("New epic · compose");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Reliability");
  });

  it("sends the frozen createEpic payload, with a fixed start date and no due date", async () => {
    let received: unknown;
    renderWithTrpc(
      <CreateEpicDialog projectId="prj-1" integrationId="int-1" open onOpenChange={() => {}} />,
      {
        "project.listGroups": () => [group()],
        "project.createEpic": (input) => {
          received = input;
          return {
            ...group(),
            iid: 3,
            title: "Reliability",
            state: "open",
            startDate: "2026-09-01",
            dueDate: null,
            groupRef: "acme/platform",
          };
        },
      },
    );

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Reliability" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Create epic/ }));

    await waitFor(() =>
      expect(received).toEqual({
        integrationId: "int-1",
        groupRef: "acme/platform",
        projectId: "prj-1",
        title: "Reliability",
        startDate: "2026-09-01",
      }),
    );
  });

  it("keeps the modal open and shows the group's message on a rejection", async () => {
    renderWithTrpc(
      <CreateEpicDialog projectId="prj-1" integrationId="int-1" open onOpenChange={() => {}} />,
      {
        "project.listGroups": () => [group()],
        "project.createEpic": () => {
          throw new Error("Insufficient permissions on this group.");
        },
      },
    );

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Reliability" } });
    fireEvent.click(screen.getByRole("button", { name: /Create epic/ }));

    expect(await screen.findByText("Insufficient permissions on this group.")).toBeDefined();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Reliability");
  });
});
