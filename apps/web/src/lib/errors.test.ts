/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
  CommonErrorCode,
  HarnessLibraryErrorCode,
  TaskDependencyErrorCode,
  TaskErrorCode,
  WorkflowErrorCode,
} from "@solow/contracts";
import { describeError, describeOptionalError, errorCode, GENERIC_ERROR } from "./errors";
import { taskActionMessage } from "./task-errors";

/** The shape a `TRPCClientError` presents to a component: a message, and tRPC's own code. */
const trpcError = (message: string, code?: string) =>
  Object.assign(new Error(message), code ? { data: { code } } : {});

/** No sentence may contain an UPPER_SNAKE wire code — the thing this module exists to hide. */
const WIRE = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/;

describe("describeError", () => {
  it("says a known wire code as a sentence, never the code", () => {
    const text = describeError(trpcError(WorkflowErrorCode.InUse, "BAD_REQUEST"));
    expect(text).toContain("A task is still on this workflow");
    expect(text).not.toMatch(WIRE);
  });

  it("has a sentence for every library code the import dialog can meet", () => {
    for (const code of Object.values(HarnessLibraryErrorCode)) {
      expect(describeError(code)).not.toBe(GENERIC_ERROR);
    }
  });

  it("reads the code ahead of detail the server appended after a colon", () => {
    expect(describeError(`${TaskDependencyErrorCode.Cycle}: a → b → a`)).toContain("in a loop");
  });

  it("lets a surface say a code more precisely than the shared table", () => {
    const wording = { [CommonErrorCode.NotFound]: "This issue no longer exists." };
    expect(describeError(trpcError(CommonErrorCode.NotFound, "NOT_FOUND"), wording)).toBe(
      "This issue no longer exists.",
    );
  });

  it("never shows a Zod issue list", () => {
    const zod = JSON.stringify([{ code: "too_small", path: ["name"], message: "Too small" }]);
    const text = describeError(trpcError(zod, "BAD_REQUEST"));
    expect(text).not.toContain("too_small");
    expect(text).toContain("Check the fields");
  });

  it("hides an unexpected server message behind tRPC's own classification", () => {
    const text = describeError(
      trpcError("SQLITE_CONSTRAINT: FOREIGN KEY constraint failed", "INTERNAL_SERVER_ERROR"),
    );
    expect(text).not.toContain("SQLITE");
    expect(text).toContain("server log");
  });

  it("tells a browser that lost the server to check it is running", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toContain("Could not reach SoloW");
  });

  it("does not blame the browser's connection for the server's own outbound failure", () => {
    expect(describeError(trpcError("fetch failed", "INTERNAL_SERVER_ERROR"))).not.toContain(
      "Could not reach SoloW",
    );
  });

  it("turns a provider refusal into its status, keeping the provider's one-line reason", () => {
    const raw =
      'github POST to https://api.github.com/repos/o/r/issues failed: 422 {"message":"Validation Failed","errors":[{"field":"labels"}]}';
    const text = describeError(trpcError(raw, "INTERNAL_SERVER_ERROR"));
    expect(text).toBe(
      "GitHub rejected the request (“Validation Failed”). Check what you entered, then try again.",
    );
    expect(text).not.toContain("api.github.com");
  });

  it("points a provider's 401 at the integration's credential", () => {
    const raw = "gitlab request to https://gitlab.example/api/v4/x failed: 401 ";
    expect(describeError(trpcError(raw, "INTERNAL_SERVER_ERROR"))).toContain("GitLab refused");
  });

  it("falls back to a generic sentence for an unknown code, rather than leaking it", () => {
    expect(describeError("SOMETHING_ADDED_LATER")).toBe(GENERIC_ERROR);
    expect(describeError(undefined)).toBe(GENERIC_ERROR);
    // `unwrap` sends an unmapped code as BAD_REQUEST; that is not a complaint about the form.
    expect(describeError(trpcError("SOMETHING_ADDED_LATER", "BAD_REQUEST"))).toBe(GENERIC_ERROR);
  });
});

describe("describeOptionalError", () => {
  it("passes nothing through as nothing, so JSX can guard on it", () => {
    expect(describeOptionalError(null)).toBeNull();
    expect(describeOptionalError(undefined)).toBeNull();
  });
});

describe("errorCode", () => {
  it("reads the wire code off a message, with or without appended detail", () => {
    expect(errorCode(trpcError(TaskErrorCode.NotReady))).toBe(TaskErrorCode.NotReady);
    expect(errorCode(`${TaskDependencyErrorCode.Cycle}: a → b`)).toBe(
      TaskDependencyErrorCode.Cycle,
    );
    expect(errorCode("Failed to fetch")).toBeNull();
  });
});

describe("taskActionMessage", () => {
  it("names the task where the shared table can only say 'that'", () => {
    expect(taskActionMessage(CommonErrorCode.NotFound)).toContain("That task no longer exists");
    expect(taskActionMessage(CommonErrorCode.RateLimited)).toContain("Too many launches");
  });

  it("reads every other code exactly as the rest of the app does", () => {
    expect(taskActionMessage(TaskErrorCode.ConcurrencyCapReached)).toBe(
      describeError(TaskErrorCode.ConcurrencyCapReached),
    );
    expect(taskActionMessage(null)).toBeNull();
  });
});
