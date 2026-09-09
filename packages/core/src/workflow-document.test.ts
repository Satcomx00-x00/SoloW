/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
  WORKFLOW_DOCUMENT_FORMAT,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  workflowDocumentSchema,
} from "@solow/contracts";
import {
  availableWorkflowName,
  type ExportableStep,
  planWorkflowImport,
  workflowDocumentFilename,
  workflowToDocument,
} from "./workflow-document.js";

/**
 * Sharing a Workflow (the export/import format).
 *
 * The whole risk in this pair is the translation: a document that keeps ids is unusable anywhere
 * else, and one that resolves names silently produces a pipeline that looks right in the designer
 * and runs on the wrong harness. So what is asserted here is the *loss* — which references survive
 * the round trip, which are substituted, and which are reported back.
 */

function step(id: string, name: string, over: Partial<ExportableStep> = {}): ExportableStep {
  return {
    id,
    name,
    agentProfileId: "ap-opus",
    promptTemplate: `${name} it.`,
    gate: "human",
    advanceOn: "review",
    onEnter: null,
    branch: null,
    mcpServerIds: [],
    skillIds: [],
    permissionMode: null,
    ...over,
  };
}

const NAMES = {
  harnessProfile: new Map([
    ["ap-opus", "Opus"],
    ["ap-codex", "Codex"],
  ]),
  mcpServer: new Map([["mcp-1", "Playwright"]]),
  skill: new Map([["sk-1", "impeccable"]]),
};

const CATALOG = {
  harnessProfiles: [
    { id: "local-codex", name: "Codex" },
    { id: "local-opus", name: "Opus" },
  ],
  mcpServers: [{ id: "local-mcp", name: "Playwright" }],
  skills: [{ id: "local-skill", name: "impeccable" }],
};

describe("workflowToDocument", () => {
  it("names the harness, the servers and the skills, so no id leaves the workspace", () => {
    const doc = workflowToDocument(
      { name: "Ship", description: "Plan, build, review." },
      [
        step("s1", "Plan"),
        step("s2", "Review", {
          agentProfileId: "ap-codex",
          mcpServerIds: ["mcp-1"],
          skillIds: ["sk-1"],
        }),
      ],
      NAMES,
    );

    expect(doc.format).toBe(WORKFLOW_DOCUMENT_FORMAT);
    expect(doc.version).toBe(WORKFLOW_DOCUMENT_VERSION);
    expect(doc.steps.map((s) => s.harnessProfile)).toEqual(["Opus", "Codex"]);
    expect(doc.steps[1]?.mcpServers).toEqual(["Playwright"]);
    expect(doc.steps[1]?.skills).toEqual(["impeccable"]);
    expect(JSON.stringify(doc)).not.toContain("ap-opus");
  });

  it("carries a step's permission posture as itself — it is not a name to resolve", () => {
    const doc = workflowToDocument(
      { name: "Ship", description: null },
      [step("s1", "Plan", { permissionMode: "plan" }), step("s2", "Build")],
      NAMES,
    );
    expect(doc.steps.map((s) => s.permissionMode)).toEqual(["plan", null]);

    const plan = planWorkflowImport(workflowDocumentSchema.parse(doc), CATALOG);
    expect(plan?.steps.map((s) => s.permissionMode)).toEqual(["plan", null]);
  });

  it("turns a branch's step ids into indices, including one that points backwards", () => {
    const doc = workflowToDocument(
      { name: "Ship", description: null },
      [
        step("s1", "Plan"),
        step("s2", "Implement"),
        step("s3", "Review", {
          branch: {
            when: { kind: "produced-changes" },
            thenStepId: "s2",
            elseStepId: null,
          },
        }),
      ],
      NAMES,
    );

    expect(doc.steps[2]?.branch).toEqual({
      when: { kind: "produced-changes" },
      thenStep: 1,
      elseStep: null,
    });
  });

  it("is accepted by the schema that reads it back — the round trip is the format", () => {
    const doc = workflowToDocument(
      { name: "Ship", description: null },
      [
        step("s1", "Plan", {
          branch: {
            when: { kind: "agent-decides", question: "Is a design review needed?" },
            thenStepId: "s2",
            elseStepId: "s2",
          },
        }),
        step("s2", "Implement", { gate: "auto", advanceOn: "agent-signal" }),
      ],
      NAMES,
    );

    const parsed = workflowDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.success).toBe(true);
  });
});

describe("workflowDocumentSchema", () => {
  it("refuses a branch index that names no step, rather than importing a dangling target", () => {
    const parsed = workflowDocumentSchema.safeParse({
      format: WORKFLOW_DOCUMENT_FORMAT,
      version: WORKFLOW_DOCUMENT_VERSION,
      name: "Ship",
      steps: [
        {
          name: "Plan",
          harnessProfile: "Opus",
          branch: { when: { kind: "produced-changes" }, thenStep: 7, elseStep: null },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses another product's JSON at the boundary", () => {
    expect(workflowDocumentSchema.safeParse({ name: "solow", version: "0.14.2" }).success).toBe(
      false,
    );
  });

  it("fills every optional field, so a hand-written document needs only a name and a harness", () => {
    const parsed = workflowDocumentSchema.parse({
      format: WORKFLOW_DOCUMENT_FORMAT,
      version: WORKFLOW_DOCUMENT_VERSION,
      name: "Ship",
      steps: [{ name: "Plan", harnessProfile: "Opus" }],
    });
    expect(parsed.steps[0]).toEqual({
      name: "Plan",
      harnessProfile: "Opus",
      promptTemplate: "",
      gate: "human",
      advanceOn: "review",
      onEnter: null,
      branch: null,
      mcpServers: [],
      skills: [],
      permissionMode: null,
    });
  });
});

/** A document naming one harness profile and one of each library item, for the import tests. */
function document(over: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return workflowDocumentSchema.parse({
    format: WORKFLOW_DOCUMENT_FORMAT,
    version: WORKFLOW_DOCUMENT_VERSION,
    name: "Ship",
    steps: [
      { name: "Plan", harnessProfile: "Opus", mcpServers: ["Playwright"], skills: ["impeccable"] },
      { name: "Review", harnessProfile: "Codex" },
    ],
    ...over,
  });
}

describe("planWorkflowImport", () => {
  it("resolves every name against the importing workspace's own ids", () => {
    const plan = planWorkflowImport(document(), CATALOG);
    expect(plan?.steps.map((s) => s.agentProfileId)).toEqual(["local-opus", "local-codex"]);
    expect(plan?.steps[0]?.mcpServerIds).toEqual(["local-mcp"]);
    expect(plan?.steps[0]?.skillIds).toEqual(["local-skill"]);
    expect(plan?.unmatchedHarnessProfiles).toEqual([]);
  });

  it("matches a name whose case differs, because that is the same profile to a person", () => {
    const plan = planWorkflowImport(document({ steps: document().steps }), {
      ...CATALOG,
      harnessProfiles: [{ id: "local-opus", name: "opus" }],
    });
    expect(plan?.steps[0]?.agentProfileId).toBe("local-opus");
  });

  it("falls back for an unmatched harness and says which name it could not honour", () => {
    const plan = planWorkflowImport(document(), {
      ...CATALOG,
      harnessProfiles: [{ id: "local-only", name: "Sonnet" }],
    });
    expect(plan?.steps.map((s) => s.agentProfileId)).toEqual(["local-only", "local-only"]);
    expect(plan?.unmatchedHarnessProfiles).toEqual(["Opus", "Codex"]);
  });

  it("prefers the caller's fallback over the first profile by name", () => {
    // Neither name in the document matches, so every Step lands on the fallback — the default
    // one alphabetically, or the one the caller chose.
    const catalog = {
      ...CATALOG,
      harnessProfiles: [
        { id: "local-z", name: "Zeta" },
        { id: "local-a", name: "Alpha" },
      ],
    };
    expect(planWorkflowImport(document(), catalog)?.steps[0]?.agentProfileId).toBe("local-a");
    expect(
      planWorkflowImport(document(), catalog, { fallbackProfileId: "local-z" })?.steps[0]
        ?.agentProfileId,
    ).toBe("local-z");
  });

  it("leaves a resolved step on its own harness, fallback or no fallback", () => {
    const plan = planWorkflowImport(document(), CATALOG, { fallbackProfileId: "local-codex" });
    expect(plan?.steps[0]?.agentProfileId).toBe("local-opus");
    expect(plan?.unmatchedHarnessProfiles).toEqual([]);
  });

  it("drops an unmatched skill or server rather than refusing the pipeline over it", () => {
    const plan = planWorkflowImport(document(), {
      ...CATALOG,
      mcpServers: [],
      skills: [],
    });
    expect(plan?.steps[0]?.mcpServerIds).toEqual([]);
    expect(plan?.steps[0]?.skillIds).toEqual([]);
    expect(plan?.unmatchedMcpServers).toEqual(["Playwright"]);
    expect(plan?.unmatchedSkills).toEqual(["impeccable"]);
  });

  it("keeps branch targets as indices, because the rows they name do not exist yet", () => {
    const plan = planWorkflowImport(
      document({
        steps: document().steps.map((s, i) =>
          i === 1
            ? { ...s, branch: { when: { kind: "produced-changes" }, thenStep: 0, elseStep: null } }
            : s,
        ),
      }),
      CATALOG,
    );
    expect(plan?.steps[1]?.branch).toEqual({
      when: { kind: "produced-changes" },
      thenStep: 0,
      elseStep: null,
    });
  });

  it("returns null when the workspace has no harness profile at all — nothing to fall back to", () => {
    expect(planWorkflowImport(document(), { ...CATALOG, harnessProfiles: [] })).toBeNull();
  });

  it("takes the caller's name over the document's, and suffixes either one that is taken", () => {
    expect(planWorkflowImport(document(), CATALOG, { name: "Ours" })?.name).toBe("Ours");
    expect(planWorkflowImport(document(), CATALOG, { taken: ["Ship"] })?.name).toBe("Ship (2)");
  });
});

describe("availableWorkflowName", () => {
  it("leaves an unused name alone", () => {
    expect(availableWorkflowName("Ship", ["Other"])).toBe("Ship");
  });

  it("counts past every suffix already taken, so importing three times gives three pipelines", () => {
    expect(availableWorkflowName("Ship", ["Ship", "Ship (2)"])).toBe("Ship (3)");
  });

  it("compares case-insensitively, since the unique index is what it is protecting", () => {
    expect(availableWorkflowName("ship", ["Ship"])).toBe("ship (2)");
  });
});

describe("workflowDocumentFilename", () => {
  it("slugs the pipeline's name so a download is findable", () => {
    expect(workflowDocumentFilename("Plan, build & review")).toBe(
      "plan-build-review.workflow.json",
    );
  });

  it("falls back for a name with nothing sluggable in it", () => {
    expect(workflowDocumentFilename("···")).toBe("workflow.workflow.json");
  });
});
