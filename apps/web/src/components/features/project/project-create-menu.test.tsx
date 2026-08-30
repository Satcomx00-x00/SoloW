/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { epicItemState, issueItemState } from "./project-create-menu";

/**
 * The two gates behind the `＋ New` menu (F23a Part 1). Both are pure — the component comment
 * promises they are "worth testing on its own", and this is where that promise is kept: the rule
 * (F23 FR-5 / Decision 0016) is that a blocked entry stays present with a *stated reason*, so every
 * disabled case must carry a non-null reason, and every enabled case a null one.
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

describe("epicItemState", () => {
  const gitlab = { id: "gitlab", name: "GitLab", issueCreates: { epics: true } };
  const github = { id: "github", name: "GitHub", issueCreates: { epics: false } };
  const integrations = [
    { id: "int-1", provider: "gitlab" },
    { id: "int-2", provider: "github" },
  ];
  const manifests = [gitlab, github];

  it("enables when the project's provider manifest declares epics", () => {
    expect(epicItemState({ integrationId: "int-1", integrations, manifests })).toEqual({
      enabled: true,
      reason: null,
      integrationId: "int-1",
    });
  });

  it("disables — no provider — for a local project", () => {
    const state = epicItemState({ integrationId: null, integrations, manifests });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("no provider");
    expect(state.integrationId).toBeNull();
  });

  it("disables with the manifest's name when the provider does not support epics", () => {
    const state = epicItemState({ integrationId: "int-2", integrations, manifests });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("GitHub does not support epics");
    // Threaded back out even when disabled — the dialog still needs to know which connection.
    expect(state.integrationId).toBe("int-2");
  });

  it("disables when the provider's capabilities have not been reported yet", () => {
    const state = epicItemState({ integrationId: "int-1", integrations, manifests: [] });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("not reported its capabilities");
    expect(state.integrationId).toBe("int-1");
  });
});
