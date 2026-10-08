/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { AttentionItemDto, SystemHealthDto } from "@solow/contracts";
import { attentionCopy, attentionNotice, healthSummary } from "./run-health";

const AT = "2026-10-08T12:00:00.000Z";
const up = { state: "ok" as const, detail: null };

function health(overrides: Partial<SystemHealthDto>): SystemHealthDto {
  return { orchestrator: up, engine: up, checkedAt: AT, ...overrides };
}

function item(overrides: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    taskId: "t-1",
    title: "Fix it",
    state: "failed",
    failureReason: null,
    kind: "failed",
    cause: "failed",
    since: AT,
    ...overrides,
  };
}

describe("healthSummary", () => {
  it("is healthy when both answer", () => {
    expect(healthSummary(health({}))).toMatchObject({ tone: "ok", label: "healthy" });
  });

  it("is healthy, with the engine unchecked, when the orchestrator did not report on it", () => {
    const summary = healthSummary(health({ engine: { state: "unknown", detail: null } }));
    expect(summary.tone).toBe("ok");
    expect(summary.services[1]?.text).toContain("Not checked");
  });

  it("blames the engine, and adds its own words after the user's", () => {
    const summary = healthSummary(
      health({ engine: { state: "unreachable", detail: "engine answered 503" } }),
    );
    expect(summary).toMatchObject({ tone: "error", label: "engine down" });
    expect(summary.services[1]?.text).toMatch(/^Not answering\..*\(engine answered 503\)$/);
    expect(summary.services[0]?.ok).toBe(true);
  });

  it("blames the orchestrator first when it is the one down", () => {
    const summary = healthSummary(
      health({
        orchestrator: { state: "unreachable", detail: "no answer" },
        engine: { state: "unknown", detail: null },
      }),
    );
    expect(summary).toMatchObject({ tone: "error", label: "orchestrator down" });
    expect(summary.services[1]?.ok).toBe(true);
  });

  it("is a caution, not an outage, for a web app started without an orchestrator", () => {
    const summary = healthSummary(
      health({ orchestrator: { state: "not_configured", detail: null } }),
    );
    expect(summary).toMatchObject({ tone: "caution", label: "no orchestrator" });
  });
});

describe("attentionCopy", () => {
  it("uses the failure reason's own words when it has them", () => {
    expect(attentionCopy(item({ failureReason: "credential_expired" })).label).toBe(
      "Credential expired",
    );
  });

  it("says something useful for a failure with no reason", () => {
    expect(attentionCopy(item({})).detail).toContain("retry");
  });

  it("names the quiet window in minutes", () => {
    expect(attentionCopy(item({ kind: "stuck", cause: "run_silent" })).detail).toContain(
      "20 minutes",
    );
  });
});

describe("attentionNotice", () => {
  it("is an error for a failure and a caution for a stuck run", () => {
    expect(attentionNotice(item({})).tone).toBe("error");
    expect(attentionNotice(item({ kind: "stuck", cause: "park_overdue" }))).toMatchObject({
      tone: "caution",
      title: "Never resumed: Fix it",
    });
  });
});
