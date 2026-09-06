/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { SkillsSection } from "./skills-section";

const AT = "2026-08-20T00:00:00.000Z";

afterEach(cleanup);

describe("SkillsSection", () => {
  it("adds a skill written here, off for every agent unless asked", async () => {
    const { log } = renderWithTrpc(<SkillsSection />, {
      "library.skill.list": () => [],
      "library.skill.create": () => ({}),
    });

    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "review-checklist" },
    });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "How we review" } });
    fireEvent.change(screen.getByLabelText("SKILL.md"), {
      target: { value: "# Review\n\nCheck the tests." },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Add skill" }).closest("form")!);

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "library.skill.create");
      expect(call?.input).toEqual({
        name: "review-checklist",
        description: "How we review",
        source: { kind: "inline", body: "# Review\n\nCheck the tests." },
        enabled: false,
      });
    });
  });

  it("lists a directory-backed skill with its path, and lets it go", async () => {
    const { log } = renderWithTrpc(<SkillsSection />, {
      "library.skill.list": () => [
        {
          id: "k1",
          name: "deploy",
          description: "Deploy runbook",
          source: { kind: "path", path: "/srv/skills/deploy" },
          enabled: true,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      "library.skill.delete": () => [],
    });

    expect(await screen.findByText("/srv/skills/deploy")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove deploy"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove skill" }));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "library.skill.delete")?.input).toEqual({ id: "k1" });
    });
  });
});
