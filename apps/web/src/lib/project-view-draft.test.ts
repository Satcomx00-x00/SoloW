/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { clearDraftOverlay, readDraftOverlay, writeDraftOverlay } from "./project-view-draft";

/**
 * The Project view's browser-local draft (user report: "Hide closed" and the rest of the
 * toolbar reset on reload). These assert the storage contract directly — parse-or-default, one
 * key per (Project, tab), and the corrupt/unreachable cases every server-side preference in this
 * app already handles the same way.
 */

beforeEach(() => window.localStorage.clear());

describe("readDraftOverlay", () => {
  it("returns nothing before anything has been written", () => {
    expect(readDraftOverlay("prj-1", "view-1")).toEqual({});
  });

  it("reads back exactly what was written", () => {
    writeDraftOverlay("prj-1", "view-1", { hideClosed: true, groupByFieldId: "f-status" });

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({
      hideClosed: true,
      groupByFieldId: "f-status",
    });
  });

  it("keeps two Projects' drafts apart", () => {
    writeDraftOverlay("prj-1", "view-1", { hideClosed: true });
    writeDraftOverlay("prj-2", "view-1", { hideClosed: false });

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({ hideClosed: true });
    expect(readDraftOverlay("prj-2", "view-1")).toEqual({ hideClosed: false });
  });

  it("keeps two tabs of the same Project apart", () => {
    writeDraftOverlay("prj-1", "view-1", { layout: "roadmap" });
    writeDraftOverlay("prj-1", "view-2", { layout: "table" });

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({ layout: "roadmap" });
    expect(readDraftOverlay("prj-1", "view-2")).toEqual({ layout: "table" });
  });

  it("degrades a value that no longer parses to nothing, rather than throwing", () => {
    window.localStorage.setItem(
      "solow:project-view-draft:prj-1:view-1",
      JSON.stringify({ layout: "not-a-real-layout" }),
    );

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({});
  });

  it("degrades a value that is not even JSON to nothing, rather than throwing", () => {
    window.localStorage.setItem("solow:project-view-draft:prj-1:view-1", "{not json");

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({});
  });
});

describe("writeDraftOverlay", () => {
  it("overwrites rather than merging with what was there before", () => {
    writeDraftOverlay("prj-1", "view-1", { hideClosed: true, groupByFieldId: "f-status" });
    writeDraftOverlay("prj-1", "view-1", { hideClosed: false });

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({ hideClosed: false });
  });

  it("removes the key entirely once there is nothing left to remember", () => {
    writeDraftOverlay("prj-1", "view-1", { hideClosed: true });

    writeDraftOverlay("prj-1", "view-1", {});

    expect(window.localStorage.getItem("solow:project-view-draft:prj-1:view-1")).toBeNull();
  });
});

describe("clearDraftOverlay", () => {
  it("removes a stored draft, so a saved view does not re-diverge on the next load", () => {
    writeDraftOverlay("prj-1", "view-1", { hideClosed: true });

    clearDraftOverlay("prj-1", "view-1");

    expect(readDraftOverlay("prj-1", "view-1")).toEqual({});
  });

  it("is a no-op when nothing was ever stored", () => {
    expect(() => clearDraftOverlay("prj-1", "view-1")).not.toThrow();
  });
});
