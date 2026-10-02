/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { HarnessConfigsSection, parseConfigText } from "./harness-configs-section";

const AT = "2026-10-02T00:00:00.000Z";

afterEach(cleanup);

const row = {
  id: "c1",
  name: "Strict",
  description: null,
  harness: "claude_code" as const,
  content: { model: "opus" },
  profileCount: 1,
  createdAt: AT,
  updatedAt: AT,
};

describe("parseConfigText", () => {
  it("names what is wrong: syntax, root, or a key SoloW owns", () => {
    expect("error" in parseConfigText("claude_code", "{")).toBe(true);
    expect(parseConfigText("claude_code", "[]")).toEqual({
      error: "The config must be a JSON object.",
    });
    expect(parseConfigText("claude_code", '{"apiKeyHelper":"x"}')).toEqual({
      error: "apiKeyHelper would bypass the profile's credential",
    });
    expect(parseConfigText("opencode", '{"theme":"dark"}')).toEqual({
      content: { theme: "dark" },
    });
  });
});

describe("HarnessConfigsSection", () => {
  it("stores the JSON typed into the editor", async () => {
    const { log } = renderWithTrpc(<HarnessConfigsSection />, {
      "profile.harnessConfig.list": () => [],
      "profile.harnessConfig.create": () => row,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Add a harness config/ }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Strict" } });
    fireEvent.change(screen.getByLabelText("settings.json"), {
      target: { value: '{ "model": "opus" }' },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Add config" }).closest("form")!);

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "profile.harnessConfig.create")?.input).toEqual({
        name: "Strict",
        harness: "claude_code",
        content: { model: "opus" },
      });
    });
  });

  it("duplicates a config, and will not delete one a profile selects", async () => {
    const { log } = renderWithTrpc(<HarnessConfigsSection />, {
      "profile.harnessConfig.list": () => [row],
      "profile.harnessConfig.duplicate": () => ({ ...row, id: "c2", name: "Strict (copy)" }),
    });

    fireEvent.click(await screen.findByLabelText("Duplicate the harness config Strict"));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "profile.harnessConfig.duplicate")?.input).toEqual({
        id: "c1",
      });
    });
    expect(
      (screen.getByLabelText("Delete the harness config Strict") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
