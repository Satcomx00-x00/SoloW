/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { findMcpTool, listMcpTools, toolNameFor } from "./tools.js";

/**
 * Which contracts the MCP surface exposes, and — the part worth a test — which it does not.
 *
 * The withheld list is a set of decisions, and a decision that lives only in a comment beside a
 * `Set` is one an edit can undo without anybody noticing. What each of these pins is the reason,
 * not the membership: `review.decide` is absent because the party that did the work does not get
 * to sign it off, and `task` is present because work management is what this surface is for.
 */

const names = () => listMcpTools().map((t) => t.name);

describe("the MCP surface", () => {
  it("does not offer the review gate", () => {
    // A token that can approve is a token that can approve its own work. The orchestrator hands
    // its harnesses no MCP configuration today, so nothing has ever reached this — which is exactly
    // why the rule belongs here now, before issue #75's task-scoped surface makes it reachable.
    expect(names()).not.toContain("review_decide");
    expect(findMcpTool("review_decide")).toBeUndefined();
  });

  it("still offers the work management the surface exists for", () => {
    // `review` is withheld as a namespace because `decide` is all it holds. `task` is not, and
    // must not be: withholding it to reach `task.move` would take `task.create`, `task.list` and
    // `task.launch` with it, which is the whole point of having an MCP surface.
    const exposed = names();
    for (const tool of ["task_create", "task_list", "task_launch", "issue_list"]) {
      expect(exposed).toContain(tool);
    }
  });

  it("lets a token build a pipeline, but never advance one or hand a harness a server", () => {
    const exposed = names();
    // Authoring (spec F03): a builder can read the rules, make the pipeline and bind a Task to it.
    for (const tool of [
      "workflow_authoringGuide",
      "workflow_create",
      "workflow_addStep",
      "workflow_updateStep",
      "workflow_reorderStep",
      "workflow_deleteStep",
      "workflow_delete",
      "workflow_attachTask",
      "workflow_get",
      "library_mcp_list",
      "library_skill_list",
    ]) {
      expect(exposed).toContain(tool);
    }
    // Running: the gates stay a person's to open, and the libraries stay a signed-in write.
    for (const withheld of [
      "workflow_advanceTask",
      "workflow_acknowledgeDrift",
      "library_mcp_create",
      "library_skill_create",
      "library_skill_import",
    ]) {
      expect(exposed).not.toContain(withheld);
    }
  });

  it("keeps withholding the ones that were withheld before", () => {
    const exposed = names();
    for (const withheld of ["secret_create", "secret_list", "mcpToken_issue", "review_decide"]) {
      expect(exposed).not.toContain(withheld);
    }
    // Nothing from a withheld namespace leaks under a different name either.
    expect(exposed.some((n) => n.startsWith("preference_"))).toBe(false);
    expect(exposed.some((n) => n.startsWith("stream_"))).toBe(false);
  });

  it("names a tool after the procedure it is, so the two cannot drift", () => {
    expect(toolNameFor("issue.setStatus")).toBe("issue_setStatus");
  });
});
