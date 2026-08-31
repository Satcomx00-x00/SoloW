/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { issueItemState, parentPlanningItemState } from "./project-create-menu";

/**
 * The two gates behind the `＋ New` menu (F23a Parts 1 and 3). Both are pure — the component
 * comment promises they are "worth testing on its own", and this is where that promise is kept:
 * the rule (F23 FR-5 / Decision 0016) is that a blocked entry stays present with a *stated reason*,
 * so every disabled case must carry a non-null reason, and every enabled case a null one.
 */

const repo = (integrationId: string | null) => ({ integrationId });

describe("issueItemState", () => {
  it("enables when at least one repository is provider-backed", () => {
    expect(issueItemState([repo("int-1"), repo(null)])).toEqual({ enabled: true, reason: null });
  });

  it("disables with a reason when every repository is local", () => {
    const state = issueItemState([repo(null), repo(null)]);
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("no provider-backed repository");
  });

  it("disables with a reason when there are no repositories at all", () => {
    const state = issueItemState([]);
    expect(state.enabled).toBe(false);
    expect(state.reason).not.toBeNull();
  });
});

describe("parentPlanningItemState", () => {
  const gitlab = {
    id: "gitlab",
    name: "GitLab",
    issueCreates: {
      epics: true,
      parentPlanningItem: { container: "group" as const, noun: "epic" },
    },
  };
  /**
   * GitHub's declaration after the split, and the reason this suite exists: `epics: false` *and* a
   * parent planning item, in a repository. It used to be the file's disabled case.
   */
  const github = {
    id: "github",
    name: "GitHub",
    issueCreates: {
      epics: false,
      parentPlanningItem: { container: "repository" as const, noun: "parent issue" },
    },
  };
  /** A provider that creates issues and originates no parent at all — the "nobody said" case. */
  const gitea = { id: "gitea", name: "Gitea", issueCreates: { epics: false } };
  const integrations = [
    { id: "int-1", provider: "gitlab" },
    { id: "int-2", provider: "github" },
    { id: "int-3", provider: "gitea" },
  ];
  const manifests = [gitlab, github, gitea];

  it("enables with the group container and the provider's own noun", () => {
    expect(parentPlanningItemState({ integrationId: "int-1", integrations, manifests })).toEqual({
      enabled: true,
      reason: null,
      integrationId: "int-1",
      container: "group",
      noun: "epic",
      epicsSupported: true,
    });
  });

  it("enables with the repository container on a provider that has no epics at all", () => {
    // The behaviour this change deliberately reverses: GitHub used to be the disabled case here,
    // with "GitHub does not support epics". It has no epics still — and it can originate a parent.
    expect(parentPlanningItemState({ integrationId: "int-2", integrations, manifests })).toEqual({
      enabled: true,
      reason: null,
      integrationId: "int-2",
      container: "repository",
      noun: "parent issue",
      epicsSupported: false,
    });
  });

  it("disables — no provider — for a local project, without naming a provider's feature", () => {
    const state = parentPlanningItemState({ integrationId: null, integrations, manifests });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("no provider");
    // The old copy said "Epics are a GitLab group feature", which is untrue of most providers and
    // of no provider at all. A reason has to be true of what the operator is looking at.
    expect(state.reason).not.toMatch(/gitlab|epic/i);
    expect(state.integrationId).toBeNull();
  });

  it("disables with the manifest's name when the provider originates no parent item", () => {
    const state = parentPlanningItemState({ integrationId: "int-3", integrations, manifests });
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("Gitea cannot originate a parent planning item.");
    // Threaded back out even when disabled — the dialog still needs to know which connection.
    expect(state.integrationId).toBe("int-3");
    expect(state.container).toBeNull();
  });

  it("disables when the provider's capabilities have not been reported yet", () => {
    const state = parentPlanningItemState({ integrationId: "int-1", integrations, manifests: [] });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("not reported its capabilities");
    expect(state.integrationId).toBe("int-1");
  });

  it("reports epicsSupported independently of whether the menu entry is enabled", () => {
    // Both directions of collapsing the two flags. A provider with epic objects it cannot
    // originate must still offer the issue form's Parent-epic picker, and must not enable the
    // menu; deriving one from the other loses whichever half is read second.
    const listOnly = {
      id: "listonly",
      name: "List Only",
      issueCreates: { epics: true },
    };
    const state = parentPlanningItemState({
      integrationId: "int-9",
      integrations: [{ id: "int-9", provider: "listonly" }],
      manifests: [listOnly],
    });
    expect(state.enabled).toBe(false);
    expect(state.epicsSupported).toBe(true);
    // And the converse, on GitHub: the menu entry is enabled and there is still no epic to pick.
    expect(
      parentPlanningItemState({ integrationId: "int-2", integrations, manifests }).epicsSupported,
    ).toBe(false);
  });
});
