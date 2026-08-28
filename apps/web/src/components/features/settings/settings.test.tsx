/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  settingsHref,
  settingsSectionFor,
  settingsSectionsIn,
} from "@/lib/navigation";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * Settings, after it stopped being one column of nine cards.
 *
 * The defect was structural rather than visual: every section rendered at once, roughly three
 * thousand lines of forms in a single scroll, while the sidebar listed four of them — so five
 * sections, two of which the command palette links straight to, could only be reached by
 * scrolling and knowing they were down there. These tests hold the two properties that fix it:
 * the registry is complete, and the page renders **one group**, chosen from the address.
 *
 * The address matters as much as the grouping. A settings page you cannot link a colleague to is
 * a page you explain over chat instead, so `?section=` is a real parameter and not component
 * state — which is exactly what a stubbed `useSearchParams` lets these tests drive.
 */
let params = new URLSearchParams();
const replaced: string[] = [];

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => replaced.push(href),
    replace: (href: string) => replaced.push(href),
    refresh: () => {},
  }),
  usePathname: () => "/settings",
  useSearchParams: () => params,
  useParams: () => ({}),
}));

const { Settings } = await import("./settings");

afterEach(() => {
  cleanup();
  params = new URLSearchParams();
  replaced.length = 0;
});

/** Enough of the server for whichever group is on screen; every section reads something. */
const HANDLERS = {
  "secret.list": () => [],
  "profile.agent.list": () => ({ items: [], nextCursor: null }),
  "profile.agentCatalog.list": () => [],
  "profile.executor.list": () => ({ items: [], nextCursor: null }),
  "repository.list": () => ({ items: [], nextCursor: null }),
  "integration.list": () => [],
  "identity.list": () => [],
  "mcpToken.list": () => [],
  "flag.list": () => [],
  "preference.getSurfaceLayout": () => ({
    surface: "status-bar",
    workspaceId: "ws-1",
    userId: "ada",
    layout: { order: [], hidden: [], shown: [], widths: {} },
  }),
};

describe("the settings registry", () => {
  it("names every section the page can render, and puts each in a listed group", () => {
    // The regression this file exists for: the sidebar's list and the page's list were two lists,
    // and five sections were in only one of them.
    const grouped = SETTINGS_GROUPS.flatMap(({ name }) => settingsSectionsIn(name));
    expect(grouped).toHaveLength(SETTINGS_SECTIONS.length);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("falls back to a real section for no parameter and for a stale one", () => {
    // `/settings` is an address people type, and an old bookmark should land on a settings page
    // rather than on nothing. Asserted against whichever section is listed first rather than a
    // literal id — the claim is "somewhere real", and pinning the name here made adding a
    // section ahead of it read as a regression.
    const first = SETTINGS_SECTIONS[0]?.id;
    expect(settingsSectionFor(null).id).toBe(first as string);
    expect(settingsSectionFor("no-such-section").id).toBe(first as string);
    expect(settingsSectionFor("flags").id).toBe("flags");
  });

  it("still understands the `#secrets` spelling that was the address for months", () => {
    expect(settingsSectionFor("#secrets").id).toBe("secrets");
  });

  it("addresses a section by parameter, not by fragment", () => {
    // Next changes a hash with `history.pushState`, which fires no event — a hash would have moved
    // the address bar and left the page showing the previous group.
    expect(settingsHref("secrets")).toBe("/settings?section=secrets");
  });
});

describe("the settings page", () => {
  it("renders only the chosen section's group", async () => {
    params = new URLSearchParams("section=flags");
    renderWithTrpc(<Settings />, HANDLERS);

    await screen.findByRole("heading", { name: "Interface", level: 1 });
    // Asserted on the cards themselves, by the id each one has carried all along — the labels
    // also appear in the narrow-screen picker, and a text match would find that instead.
    expect(document.getElementById("flags")).not.toBeNull();
    expect(document.getElementById("status-bar")).not.toBeNull();
    // And nothing from any other group — the seven cards you did not come for.
    expect(document.getElementById("secrets")).toBeNull();
    expect(document.getElementById("integrations")).toBeNull();
    expect(document.getElementById("mcp")).toBeNull();
  });

  it("opens on the first group when the address names no section", async () => {
    renderWithTrpc(<Settings />, HANDLERS);

    const first = SETTINGS_SECTIONS[0];
    expect(
      await screen.findByRole("heading", { name: first?.group as string, level: 1 }),
    ).toBeDefined();
    expect(document.getElementById(first?.id as string)).not.toBeNull();
    // Only the addressed group is rendered — a page listing every section at once was the thing
    // the group picker replaced.
    expect(document.getElementById("flags")).toBeNull();
  });

  it("keeps the sections of a group in the order they are set up in", async () => {
    params = new URLSearchParams("section=agent-profiles");
    renderWithTrpc(<Settings />, HANDLERS);

    await screen.findByRole("heading", { name: "Agents", level: 1 });
    // A Secret, then the Agent Profile that spends it, then somewhere to execute — the sequence
    // the old single column was arranged to show, kept.
    expect(settingsSectionsIn("Agents").map((s) => s.id)).toEqual([
      "secrets",
      "agent-profiles",
      "executor-profiles",
    ]);
  });

  it("adopts a legacy `#hash` address and rewrites it", async () => {
    window.location.hash = "#status-bar";
    renderWithTrpc(<Settings />, HANDLERS);

    await screen.findByRole("heading", { level: 1 });
    expect(replaced).toContain("/settings?section=status-bar");
    window.location.hash = "";
  });
});
