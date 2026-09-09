/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  WORKFLOW_DOCUMENT_FORMAT,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowStepDto,
  type WorkflowWithStepsDto,
  workflowDocumentSchema,
} from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { ExportWorkflowButton, ImportWorkflowDialog } from "./workflow-transfer";

/**
 * Sharing a pipeline, from the surface's side.
 *
 * What matters here is not the JSON — that is `@solow/core`'s suite — but the two things the UI
 * is uniquely responsible for: handing the browser a file named after the pipeline, and refusing
 * to send a file that is not a workflow document *before* it reaches the server.
 */

const AT = "2026-08-20T00:00:00.000Z";

const STEP: WorkflowStepDto = {
  id: "st-1",
  workflowId: "wf-1",
  name: "Plan",
  position: 0,
  rank: "1",
  agentProfileId: "ap-1",
  promptTemplate: "Plan it.",
  gate: "human",
  advanceOn: "review",
  onEnter: null,
  branch: null,
  mcpServerIds: [],
  skillIds: [],
  permissionMode: null,
  createdAt: AT,
  updatedAt: AT,
};

const WORKFLOW: WorkflowWithStepsDto = {
  id: "wf-1",
  name: "Plan, build, review",
  description: null,
  version: 4,
  stepCount: 1,
  steps: [STEP],
  createdAt: AT,
  updatedAt: AT,
};

const DOCUMENT = {
  format: WORKFLOW_DOCUMENT_FORMAT,
  version: WORKFLOW_DOCUMENT_VERSION,
  name: "Plan, build, review",
  description: null,
  steps: [
    { name: "Plan", harnessProfile: "Opus" },
    { name: "Review", harnessProfile: "Gemini" },
  ],
};

/**
 * Catch the file the download hands the browser, without leaving the DOM.
 *
 * The blob is recorded as it is created rather than looked up from the anchor's `href`: a DOM
 * stand-in is free to rewrite a `blob:` URL into an absolute one, and the test should not be
 * asserting on how it chose to.
 */
function captureDownload() {
  const saved: { name: string; blob: Blob }[] = [];
  let latest: Blob | null = null;
  const url = globalThis.URL as unknown as {
    createObjectURL: (b: Blob) => string;
    revokeObjectURL: (u: string) => void;
  };
  const before = { create: url.createObjectURL, revoke: url.revokeObjectURL };

  url.createObjectURL = (blob: Blob) => {
    latest = blob;
    return "blob:test";
  };
  url.revokeObjectURL = () => {};

  const anchor = HTMLAnchorElement.prototype as { click: () => void };
  const clicked = anchor.click;
  anchor.click = function click(this: HTMLAnchorElement) {
    if (latest) saved.push({ name: this.download, blob: latest });
  };

  return {
    saved,
    restore: () => {
      url.createObjectURL = before.create;
      url.revokeObjectURL = before.revoke;
      anchor.click = clicked;
    },
  };
}

/** A `File` the dialog can read, as the picker would hand it over. */
function jsonFile(name: string, body: unknown): File {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    name,
    text: () => Promise.resolve(text),
  } as unknown as File;
}

/** happy-dom's file input is read-only; hand the change event the file directly. */
function pick(input: HTMLElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

afterEach(cleanup);

describe("ExportWorkflowButton", () => {
  it("downloads the document under a file name made from the pipeline's own name", async () => {
    const download = captureDownload();
    try {
      const { log } = renderWithTrpc(<ExportWorkflowButton workflow={WORKFLOW} />, {
        "workflow.export": () => DOCUMENT,
      });

      fireEvent.click(screen.getByRole("button", { name: "Export as JSON" }));

      await waitFor(() => expect(download.saved).toHaveLength(1));
      expect(download.saved[0]?.name).toBe("plan-build-review.workflow.json");
      expect(log.calls).toEqual([{ path: "workflow.export", input: { id: "wf-1" } }]);
      // Pretty-printed, because the file is meant to be read and edited by hand.
      const file = download.saved[0];
      if (!file) throw new Error("nothing was downloaded");
      const body = await file.blob.text();
      expect(JSON.parse(body)).toEqual(DOCUMENT);
      expect(body).toContain('\n  "format"');
    } finally {
      download.restore();
    }
  });

  it("says why nothing was downloaded rather than failing silently", async () => {
    const download = captureDownload();
    try {
      renderWithTrpc(<ExportWorkflowButton workflow={WORKFLOW} />, {
        "workflow.export": () => {
          throw new Error("WORKFLOW_EMPTY");
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "Export as JSON" }));

      expect((await screen.findByRole("alert")).textContent).toContain("WORKFLOW_EMPTY");
      expect(download.saved).toHaveLength(0);
    } finally {
      download.restore();
    }
  });
});

const PROFILES = {
  "profile.agent.list": () => ({
    items: [
      { id: "ap-1", name: "Opus" },
      { id: "ap-2", name: "Codex" },
    ],
    nextCursor: null,
  }),
};

function openImport(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const result = renderWithTrpc(
    <ImportWorkflowDialog trigger={<button type="button">Import from file</button>} />,
    {
      ...PROFILES,
      ...handlers,
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Import from file" }));
  return result;
}

describe("ImportWorkflowDialog", () => {
  it("refuses a file that is not a workflow document, without asking the server", async () => {
    const { log } = openImport();

    pick(
      await screen.findByLabelText("Workflow file"),
      jsonFile("package.json", { name: "solow" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Not a workflow document");
    expect(log.calls.some((c) => c.path === "workflow.import")).toBe(false);
  });

  it("names the file's own problem when it is not even JSON", async () => {
    openImport();
    pick(await screen.findByLabelText("Workflow file"), jsonFile("pipeline.json", "not json{"));
    expect((await screen.findByRole("alert")).textContent).toContain("That file is not JSON.");
  });

  it("previews the steps and marks the harness this workspace has nothing called", async () => {
    openImport();
    pick(await screen.findByLabelText("Workflow file"), jsonFile("ship.json", DOCUMENT));

    expect(await screen.findByText("2 steps")).toBeTruthy();
    // The document's second step names a profile that is not in the catalog, so the dialog offers
    // somewhere for it to land before anything is written.
    expect(await screen.findByLabelText("Harness for unmatched steps")).toBeTruthy();
  });

  it("sends the document, and the name only when the operator changed it", async () => {
    const { log } = openImport({
      "workflow.import": () => ({
        workflow: { ...WORKFLOW, id: "wf-new", name: "Plan, build, review" },
        unmatchedHarnessProfiles: [],
        unmatchedMcpServers: [],
        unmatchedSkills: [],
      }),
    });
    pick(await screen.findByLabelText("Workflow file"), jsonFile("ship.json", DOCUMENT));

    fireEvent.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.import");
      // The dialog sends the document the schema parsed, defaults and all — not the raw file.
      expect(call?.input).toEqual({ document: workflowDocumentSchema.parse(DOCUMENT) });
    });
  });

  it("reports every substitution instead of closing on a lossy import", async () => {
    openImport({
      "workflow.import": () => ({
        workflow: { ...WORKFLOW, id: "wf-new" },
        unmatchedHarnessProfiles: ["Gemini"],
        unmatchedMcpServers: [],
        unmatchedSkills: ["impeccable"],
      }),
    });
    pick(await screen.findByLabelText("Workflow file"), jsonFile("ship.json", DOCUMENT));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));

    expect(await screen.findByText("Gemini")).toBeTruthy();
    expect(await screen.findByText("impeccable")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open pipeline" })).toBeTruthy();
  });
});
