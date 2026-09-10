import { describe, expect, it } from "bun:test";
import { libraryNameSchema, workflowDocumentSchema } from "@solow/contracts";
import { validateWorkflowGraph } from "../workflow.js";
import {
  VENDORED_STORE,
  WORKFLOW_STORE,
  WORKFLOW_STORE_CATEGORIES,
  WORKFLOW_STORE_SEEDS,
  WORKFLOW_STORE_SOURCES,
  workflowStoreDocument,
  workflowStoreEntry,
  workflowStoreSkills,
} from "./index.js";

describe("the Workflow store", () => {
  it("has the everyday pipelines and the three methods, each in a real category", () => {
    expect(WORKFLOW_STORE.length).toBeGreaterThanOrEqual(15);
    for (const id of ["speckit-sdd", "superpowers-feature", "openspec-change"]) {
      expect(workflowStoreEntry(id)?.category).toBe("methodology");
    }
    const categories = new Set(WORKFLOW_STORE_CATEGORIES.map((c) => c.id));
    for (const entry of WORKFLOW_STORE) expect(categories.has(entry.category)).toBe(true);
    // Every category the chips offer has something behind it.
    for (const category of categories) {
      expect(WORKFLOW_STORE.some((e) => e.category === category)).toBe(true);
    }
  });

  it("never reuses an id or a title, and bundles every Skill a Step names under a library name", () => {
    expect(new Set(WORKFLOW_STORE.map((e) => e.id)).size).toBe(WORKFLOW_STORE.length);
    expect(new Set(WORKFLOW_STORE.map((e) => e.title.toLowerCase())).size).toBe(
      WORKFLOW_STORE.length,
    );
    for (const entry of WORKFLOW_STORE) {
      expect(entry.homepage).toMatch(/^https:\/\//);
      expect(entry.steps.length).toBeGreaterThan(0);
      // Resolving throws for a name the generated file does not hold.
      const bundled = new Set(workflowStoreSkills(entry).map((s) => s.name));
      for (const skill of workflowStoreSkills(entry)) {
        expect(libraryNameSchema.safeParse(skill.name).success).toBe(true);
        expect(skill.description.length).toBeLessThanOrEqual(500);
        expect(skill.body.length).toBeGreaterThan(200);
      }
      for (const step of entry.steps) {
        for (const name of step.skills ?? []) expect(bundled.has(name)).toBe(true);
        // A human gate that advances on a signal would never wait; the two travel together.
        if (step.gate === "human") expect(step.advanceOn).toBe("review");
      }
    }
  });

  it("produces, for every entry, a document the import schema accepts and a graph a Task can walk", () => {
    for (const entry of WORKFLOW_STORE) {
      const document = workflowStoreDocument(entry, "Default");
      const parsed = workflowDocumentSchema.safeParse(document);
      if (!parsed.success) throw new Error(`${entry.id}: ${parsed.error.message}`);
      expect(parsed.data.steps.every((s) => s.harnessProfile === "Default")).toBe(true);

      // What `attachTaskWorkflow` checks before a Task starts down the pipeline.
      const steps = parsed.data.steps.map((step, index) => ({
        id: `s${index}`,
        rank: String(index).padStart(3, "0"),
        branch: step.branch
          ? {
              when: step.branch.when,
              thenStepId: step.branch.thenStep === null ? null : `s${step.branch.thenStep}`,
              elseStepId: step.branch.elseStep === null ? null : `s${step.branch.elseStep}`,
            }
          : null,
      }));
      const problems = validateWorkflowGraph(steps);
      if (problems.length > 0) throw new Error(`${entry.id}: ${JSON.stringify(problems)}`);
    }
  });

  it("holds only vendored text: every Skill comes from a named source at a recorded revision", () => {
    const sources = new Set(WORKFLOW_STORE_SOURCES.map((s) => s.id));
    for (const [name, skill] of Object.entries(VENDORED_STORE.skills)) {
      expect(sources.has(skill.source)).toBe(true);
      expect(skill.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    }
    for (const source of WORKFLOW_STORE_SOURCES) {
      const recorded = VENDORED_STORE.sources[source.id];
      if (source.kind === "repository") expect(recorded?.commit).toMatch(/^[0-9a-f]{40}$/);
      for (const spec of source.skills)
        expect(VENDORED_STORE.skills[spec.name]?.path).toBe(spec.path);
    }
  });

  it("seeds three pipelines, none of which brings a Skill the database package could not write", () => {
    expect(WORKFLOW_STORE_SEEDS.map((e) => e.title)).toEqual([
      "Implement & review",
      "Plan, then build",
      "Bug fix",
    ]);
    for (const entry of WORKFLOW_STORE_SEEDS) {
      expect(entry.skills).toEqual([]);
      expect(entry.steps.every((s) => (s.skills ?? []).length === 0)).toBe(true);
    }
  });

  it("refuses a recipe whose branch names a Step it does not have, before it becomes a document", () => {
    const entry = workflowStoreEntry("review-then-fix");
    if (!entry) throw new Error("fixture");
    const broken = {
      ...entry,
      steps: entry.steps.map((s, i) =>
        i === 0 && s.branch ? { ...s, branch: { ...s.branch, yes: "Nowhere" } } : s,
      ),
    };
    expect(() => workflowStoreDocument(broken, "Default")).toThrow(/Nowhere/);
  });

  it("dedupes the Skills an entry bundles by name", () => {
    const entry = workflowStoreEntry("security-review");
    if (!entry) throw new Error("fixture");
    const doubled = { ...entry, skills: [...entry.skills, ...entry.skills] };
    expect(workflowStoreSkills(doubled).map((s) => s.name)).toEqual(["security-review-checklist"]);
    expect(() => workflowStoreSkills({ ...entry, skills: ["not-vendored"] })).toThrow(
      /not vendored/,
    );
  });
});
