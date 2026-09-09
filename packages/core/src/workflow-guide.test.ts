import { describe, expect, it } from "bun:test";
import { WORKFLOW_AUTHORING_GUIDE } from "./workflow-guide.js";

describe("the workflow authoring guide", () => {
  it("names every tool a builder needs, the branch shape, and what stays withheld", () => {
    for (const needle of [
      "workflow_create",
      "workflow_addStep",
      "workflow_updateStep",
      "workflow_reorderStep",
      "workflow_attachTask",
      "workflow_export",
      "workflow_import",
      "permissionMode",
      "bypassPermissions",
      "task_launch",
      "library_mcp_list",
      "agent-decides",
      "produced-changes",
      "thenStepId",
      "elseStepId",
      "WORKFLOW_GRAPH_INVALID",
      "workflow.advanceTask",
    ]) {
      expect(WORKFLOW_AUTHORING_GUIDE).toContain(needle);
    }
  });
});
