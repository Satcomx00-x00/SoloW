/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { SkillsSection } from "./skills-section";

afterEach(cleanup);

const AT = "2026-08-20T00:00:00.000Z";

describe("ImportSkillsDialog", () => {
  it("scans a directory, unticks what the library already holds, and imports the rest as picked", async () => {
    const { log } = renderWithTrpc(<SkillsSection />, {
      "library.skill.list": () => [],
      "library.skill.scan": () => ({
        root: "/srv/skills",
        skills: [
          {
            name: "deploy",
            description: "How we ship.",
            path: "/srv/skills/deploy",
            relativePath: "deploy",
            files: 3,
            existing: true,
          },
          {
            name: "review-checklist",
            description: "How we review",
            path: "/srv/skills/review",
            relativePath: "review",
            files: 2,
            existing: false,
          },
          {
            name: "triage",
            description: "Imported from triage",
            path: "/srv/skills/triage",
            relativePath: "triage",
            files: 1,
            existing: false,
          },
        ],
      }),
      "library.skill.import": () => ({
        imported: [
          {
            id: "k1",
            name: "review-checklist",
            description: "How we review",
            source: { kind: "path", path: "/srv/skills/review" },
            enabled: false,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
        skipped: [],
      }),
    });

    fireEvent.click((await screen.findAllByRole("button", { name: /Import/ }))[0]!);
    fireEvent.change(await screen.findByLabelText("Directory"), {
      target: { value: "/srv/skills" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "library.skill.scan")?.input).toEqual({
        source: { kind: "path", path: "/srv/skills" },
      });
    });
    const locked = (await screen.findByLabelText("Import deploy")) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText("already in the library")).toBeTruthy();
    expect(screen.getByText("3 files")).toBeTruthy();

    // Two ticked by default; leave one out.
    expect(screen.getByRole("button", { name: "Import 2 skills" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Import triage"));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 skill" }));

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "library.skill.import")?.input).toEqual({
        skills: [
          { name: "review-checklist", description: "How we review", path: "/srv/skills/review" },
        ],
        enabled: false,
      });
    });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Imported 1 skill");
  });

  it("unpacks a .zip picked in the dialog, sending its bytes as base64", async () => {
    const { log } = renderWithTrpc(<SkillsSection />, {
      "library.skill.list": () => [],
      "library.skill.unpack": () => ({
        root: "/srv/.solow/skills/team",
        skills: [
          {
            name: "triage",
            description: "How we triage.",
            path: "/srv/.solow/skills/team/skills/triage",
            relativePath: "skills/triage",
            files: 2,
            existing: false,
          },
        ],
      }),
    });
    fireEvent.click((await screen.findAllByRole("button", { name: /Import/ }))[0]!);
    fireEvent.click(screen.getByRole("combobox", { name: "From" }));
    fireEvent.click(await screen.findByRole("option", { name: "A .zip file" }));

    const file = new File([new Uint8Array([80, 75, 3, 4, 1, 2, 3])], "team.zip", {
      type: "application/zip",
    });
    fireEvent.change(await screen.findByLabelText("Archive"), { target: { files: [file] } });

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "library.skill.unpack")?.input).toEqual({
        fileName: "team.zip",
        zipBase64: "UEsDBAECAw==",
      });
    });
    expect(await screen.findByLabelText("Import triage")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 skill" })).toBeTruthy();
  });

  it("takes a .zip dropped anywhere on the Skills card, and opens straight onto what it holds", async () => {
    const { log } = renderWithTrpc(<SkillsSection />, {
      "library.skill.list": () => [],
      "library.skill.unpack": () => ({ root: "/srv/.solow/skills/x", skills: [] }),
    });
    const card = (await screen.findByText("Skills")).closest("[id=skills]") as HTMLElement;
    const file = new File([new Uint8Array([80, 75])], "x.zip", { type: "application/zip" });
    const dataTransfer = { types: ["Files"], files: [file], dropEffect: "none" };
    fireEvent.dragEnter(card, { dataTransfer });
    expect(screen.getByRole("status").textContent).toContain("Drop the .zip");
    fireEvent.drop(card, { dataTransfer });

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "library.skill.unpack")?.input).toEqual({
        fileName: "x.zip",
        zipBase64: "UEs=",
      });
    });
    expect(await screen.findByText("No SKILL.md found under there.")).toBeTruthy();
  });

  it("says why a repository could not be scanned", async () => {
    renderWithTrpc(<SkillsSection />, {
      "library.skill.list": () => [],
      "library.skill.scan": () => {
        throw new Error("AGENT_LIBRARY_IMPORT_CLONE_FAILED");
      },
    });
    fireEvent.click((await screen.findAllByRole("button", { name: /Import/ }))[0]!);
    fireEvent.click(screen.getByRole("combobox", { name: "From" }));
    fireEvent.click(await screen.findByRole("option", { name: "A git repository" }));
    fireEvent.change(await screen.findByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/skills.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be fetched");
  });
});
