/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillFrontmatter, type VendoredStore, WORKFLOW_STORE_SOURCES } from "@solow/core";
import {
  check,
  readGenerated,
  serialize,
  speckitCommandToSkill,
  sync,
  validateSkill,
} from "./sync-workflow-store.js";

/**
 * The parts of the sync that decide something, without the network: how a Spec Kit command
 * becomes a Skill, what a fetched file has to satisfy, and what the offline check refuses. The
 * fetch itself is exercised by `bun run store:sync` in CI, against the real repositories.
 */

const SPECIFY = `---
description: Create the spec.
scripts:
  sh: scripts/bash/create-new-feature.sh --json "{ARGS}"
  ps: scripts/powershell/create-new-feature.ps1 -Json "{ARGS}"
handoffs:
  - label: Plan
    agent: speckit.plan
---

Run \`{SCRIPT}\` from the repo root for __AGENT__, then read $ARGUMENTS and {ARGS}.
${"x".repeat(200)}
`;

describe("speckitCommandToSkill", () => {
  it("resolves the three placeholders the way specify init does, and drops the CLI-only frontmatter", () => {
    const skill = speckitCommandToSkill("speckit-specify", SPECIFY);
    expect(skill.description).toBe("Create the spec.");
    expect(skill.body.startsWith("# Spec Kit — specify\n\n")).toBe(true);
    expect(skill.body).toContain(
      'Run `scripts/bash/create-new-feature.sh --json "$ARGUMENTS"` from the repo root for claude, then read $ARGUMENTS and $ARGUMENTS.',
    );
    expect(skill.body).not.toContain("handoffs");
    expect(skill.body).not.toContain("{SCRIPT}");
  });

  it("names the missing script rather than leaving a placeholder when the frontmatter has none", () => {
    const skill = speckitCommandToSkill("speckit-plan", "---\ndescription: d\n---\nUse {SCRIPT}.");
    expect(skill.body).toContain("Use the project's spec-kit script for this step.");
  });
});

describe("validateSkill", () => {
  const ok = { description: "A playbook.", body: "# Title\n".padEnd(300, "x") };
  it("accepts a named, described, non-trivial markdown body", () => {
    expect(() => validateSkill("brainstorming", ok)).not.toThrow();
  });
  it("refuses a bad name, a missing description, a stub, and an HTML error page", () => {
    expect(() => validateSkill("Not A Name", ok)).toThrow(/library name/);
    expect(() => validateSkill("x", { ...ok, description: " " })).toThrow(/no description/);
    expect(() => validateSkill("x", { ...ok, body: "# stub\n" })).toThrow(/stub/);
    expect(() => validateSkill("x", { ...ok, body: `<!DOCTYPE html>${ok.body}` })).toThrow(/HTML/);
  });
});

describe("check", () => {
  it("passes the committed generated file, and names what a hand edit or a missing skill breaks", () => {
    const store = readGenerated();
    expect(check(store)).toEqual([]);

    const edited: VendoredStore = structuredClone(store);
    const first = Object.keys(edited.skills)[0] ?? "";
    edited.skills[first] = {
      ...edited.skills[first]!,
      body: `${edited.skills[first]!.body}tampered\n`,
    };
    expect(check(edited)).toEqual([`${first}: body does not match its sha256 — edited by hand?`]);

    const missing: VendoredStore = structuredClone(store);
    delete missing.skills["speckit-specify"];
    const problems = check(missing);
    expect(problems).toContain("speckit-specify: in the manifest, not in the generated file");
    expect(problems).toContain("speckit-sdd: names speckit-specify, which is not vendored");

    const stray: VendoredStore = structuredClone(store);
    stray.skills["unlisted"] = { ...store.skills["brainstorming"]!, source: "superpowers" };
    expect(check(stray)).toEqual(["unlisted: in the generated file, not in the manifest"]);

    const uncommitted: VendoredStore = structuredClone(store);
    uncommitted.sources["superpowers"] = { ...uncommitted.sources["superpowers"]!, commit: null };
    expect(check(uncommitted)).toEqual(["source superpowers records no commit"]);
  });
});

/**
 * The fetch path, against a fake GitHub: what the sync asks for, in what order, and what it
 * refuses. `fetch` is swapped on `globalThis` for the test and put back after, because the
 * script calls the global the way a script does — a fetch parameter would exist for the test only.
 */
describe("sync", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const SHA = "a".repeat(40);
  const skillMd = (name: string) =>
    `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\n# ${name}\n\n${"Guidance. ".repeat(40)}\n`;
  const commandMd = (name: string) =>
    `---\ndescription: The ${name} command.\n---\n\n$ARGUMENTS then {SCRIPT}.\n${"Steps. ".repeat(40)}\n`;

  /** A GitHub that answers every manifest path, and records what was asked. */
  function fakeGithub(overrides: Record<string, () => Response> = {}) {
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      const override = Object.entries(overrides).find(([suffix]) => url.endsWith(suffix));
      if (override) return override[1]();
      if (url.startsWith("https://api.github.com/repos/") && url.includes("/commits/")) {
        expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github.sha");
        return new Response(SHA);
      }
      const raw =
        /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([0-9a-f]{40})\/(.+)$/.exec(url);
      if (!raw) return new Response("not found", { status: 404 });
      const [, commit, path] = raw;
      expect(commit).toBe(SHA);
      const name = path?.split("/").at(-2) ?? "";
      return new Response(
        path?.startsWith("templates/commands/")
          ? commandMd(path.split("/").at(-1)?.replace(/\.md$/, "") ?? "")
          : skillMd(name),
      );
    }) as typeof fetch;
    return asked;
  }

  it("resolves each ref to a commit, reads every file at that commit, and records the provenance", async () => {
    const asked = fakeGithub();
    const store = await sync();

    for (const source of WORKFLOW_STORE_SOURCES) {
      if (source.kind !== "repository") continue;
      expect(store.sources[source.id]).toEqual({
        repository: `https://github.com/${source.repository}`,
        ref: source.ref,
        commit: SHA,
        license: source.license,
      });
      for (const spec of source.skills) {
        expect(asked).toContain(
          `https://raw.githubusercontent.com/${source.repository}/${SHA}/${spec.path}`,
        );
        expect(store.skills[spec.name]?.source).toBe(source.id);
        expect(store.skills[spec.name]?.path).toBe(spec.path);
      }
    }
    // One commit lookup per repository, no more.
    expect(asked.filter((u) => u.includes("/commits/")).length).toBe(
      WORKFLOW_STORE_SOURCES.filter((s) => s.kind === "repository").length,
    );
    // The local source is read from disk, never fetched.
    expect(asked.some((u) => u.includes("solow"))).toBe(false);
    expect(store.sources.solow).toEqual({
      repository: null,
      ref: null,
      commit: null,
      license: "Apache-2.0",
    });
    expect(check(store)).toEqual([]);
  });

  it("turns a Spec Kit command into a Skill and keeps a SKILL.md as it is", async () => {
    fakeGithub();
    const store = await sync();
    expect(store.skills["speckit-plan"]?.description).toBe("The plan command.");
    expect(store.skills["speckit-plan"]?.body.startsWith("# Spec Kit — plan\n")).toBe(true);
    expect(store.skills["speckit-plan"]?.body).not.toContain("{SCRIPT}");
    expect(store.skills.brainstorming?.description).toBe("What brainstorming is for.");
    expect(store.skills.brainstorming?.body.startsWith("# brainstorming\n")).toBe(true);
  });

  it("sends the token when one is set, and nothing when none is", async () => {
    const seen: (string | null)[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      return new Response("x", { status: 500 });
    }) as typeof fetch;
    const previous = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "ghs_test";
      await expect(sync()).rejects.toThrow(/HTTP 500/);
      expect(seen).toEqual(["Bearer ghs_test"]);
      seen.length = 0;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      await expect(sync()).rejects.toThrow(/HTTP 500/);
      expect(seen).toEqual([null]);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it("fails the whole run on a source that cannot be fetched, a ref that resolves to nothing, or a file that is not a Skill", async () => {
    fakeGithub({ "/skills/brainstorming/SKILL.md": () => new Response("gone", { status: 404 }) });
    await expect(sync()).rejects.toThrow(/brainstorming\/SKILL\.md: HTTP 404/);

    fakeGithub({ "/commits/main": () => new Response("main") });
    await expect(sync()).rejects.toThrow(/could not resolve main to a commit/);

    fakeGithub({
      "/skills/openspec-propose/SKILL.md": () =>
        new Response("<!DOCTYPE html><html>rate limited</html>"),
    });
    await expect(sync()).rejects.toThrow(/openspec-propose: (no description|body is)/);

    fakeGithub({
      "/templates/commands/tasks.md": () => new Response("---\ndescription: d\n---\nshort"),
    });
    await expect(sync()).rejects.toThrow(/speckit-tasks: body is \d+ chars/);
  });

  it("serializes with sorted keys and a trailing newline, so an unchanged upstream rewrites nothing", async () => {
    fakeGithub();
    const store = await sync();
    const text = serialize(store);
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(text) as VendoredStore;
    expect(Object.keys(parsed.skills)).toEqual([...Object.keys(parsed.skills)].sort());
    expect(Object.keys(parsed.sources)).toEqual([...Object.keys(parsed.sources)].sort());
    expect(Object.keys(parsed)).toEqual(["generatedAt", "sources", "skills"]);
    // Same input, same bytes — apart from the timestamp the writer already discounts.
    const again = serialize({ ...store, generatedAt: store.generatedAt });
    expect(again).toBe(text);
  });
});

describe("the local skills SoloW owns", () => {
  it("are every file under skills/, each a SKILL.md whose frontmatter name is its file name, and nothing the manifest does not list", () => {
    const dir = join(import.meta.dir, "../packages/core/src/workflow-store/skills");
    const local = WORKFLOW_STORE_SOURCES.find((s) => s.id === "solow");
    if (!local) throw new Error("fixture");
    const listed = new Set(local.skills.map((s) => s.path));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(files).toEqual([...listed].sort());
    for (const file of files) {
      const fm = readSkillFrontmatter(readFileSync(join(dir, file), "utf8"));
      expect(fm.name).toBe(file.replace(/\.md$/, ""));
      expect(fm.description?.length ?? 0).toBeGreaterThan(20);
      expect(() =>
        validateSkill(fm.name ?? "", { description: fm.description ?? "", body: fm.body }),
      ).not.toThrow();
    }
    expect(existsSync(join(dir, "..", "vendored.generated.json"))).toBe(true);
  });
});
