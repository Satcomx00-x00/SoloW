/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { parseSkillLocator, skillMatchesRequest, splitCommandLine } from "./skill-locator.js";

/**
 * Every spelling of "this Skill, there" that `npx skills add`, `npx skills-installer install`
 * and `npx add-skill` accept, read into one locator (spec F24).
 */

const gh = (repo: string, extra: Partial<ReturnType<typeof repoOf>> = {}) => ({
  ...repoOf(`https://github.com/${repo}`),
  ...extra,
});
const repoOf = (url: string) => ({
  kind: "repository" as const,
  url,
  ref: null as string | null,
  subpath: null as string | null,
  skills: [] as string[],
});

describe("parseSkillLocator", () => {
  it("reads the GitHub shorthands: owner/repo, a path inside, @skill, github:", () => {
    expect(parseSkillLocator("vercel-labs/agent-skills")).toEqual(gh("vercel-labs/agent-skills"));
    expect(parseSkillLocator("anthropics/skills/skills/pdf")).toEqual(
      gh("anthropics/skills", { subpath: "skills/pdf" }),
    );
    expect(parseSkillLocator("anthropics/skills/pdf/")).toEqual(
      gh("anthropics/skills", { subpath: "pdf" }),
    );
    expect(parseSkillLocator("vercel-labs/agent-skills@react-best-practices")).toEqual(
      gh("vercel-labs/agent-skills", { skills: ["react-best-practices"] }),
    );
    expect(parseSkillLocator("github:acme/skills/tools#v2@Deploy")).toEqual(
      gh("acme/skills", { subpath: "tools", ref: "v2", skills: ["deploy"] }),
    );
    // skills-installer writes a leading `@`; it means nothing more.
    expect(parseSkillLocator("@anthropics/skills/frontend-design")).toEqual(
      gh("anthropics/skills", { subpath: "frontend-design" }),
    );
    expect(parseSkillLocator("gitlab:group/sub/skills#main")).toEqual({
      ...repoOf("https://gitlab.com/group/sub/skills"),
      ref: "main",
    });
  });

  it("reads forge URLs, with the ref and directory a /tree/ or /blob/ URL carries", () => {
    expect(parseSkillLocator("https://github.com/Acme/Skills.git")).toEqual(gh("Acme/Skills"));
    expect(parseSkillLocator("https://github.com/acme/skills/tree/main/skills/deploy")).toEqual(
      gh("acme/skills", { ref: "main", subpath: "skills/deploy" }),
    );
    expect(parseSkillLocator("https://github.com/acme/skills/tree/release%2F2")).toEqual(
      gh("acme/skills", { ref: "release/2" }),
    );
    expect(
      parseSkillLocator("https://github.com/acme/skills/blob/main/skills/deploy/SKILL.md"),
    ).toEqual(gh("acme/skills", { ref: "main", subpath: "skills/deploy" }));
    expect(
      parseSkillLocator(
        "https://raw.githubusercontent.com/acme/skills/refs/heads/main/skills/deploy/SKILL.md",
      ),
    ).toEqual(gh("acme/skills", { ref: "main", subpath: "skills/deploy" }));
    expect(
      parseSkillLocator("https://gitlab.com/group/sub/skills/-/tree/main/skills/deploy"),
    ).toEqual({
      ...repoOf("https://gitlab.com/group/sub/skills"),
      ref: "main",
      subpath: "skills/deploy",
    });
    expect(parseSkillLocator("https://gitlab.com/group/skills.git#v1")).toEqual({
      ...repoOf("https://gitlab.com/group/skills"),
      ref: "v1",
    });
    expect(parseSkillLocator("git@github.com:acme/skills.git")).toEqual(gh("acme/skills"));
    expect(parseSkillLocator("ssh://git@git.example.com:2222/team/skills.git")).toEqual(
      repoOf("https://git.example.com/team/skills"),
    );
    expect(
      parseSkillLocator("https://dev.azure.com/org/proj/_git/skills?path=/skills&version=GBmain"),
    ).toEqual({
      ...repoOf("https://dev.azure.com/org/proj/_git/skills"),
      ref: "main",
      subpath: "skills",
    });
  });

  it("reads a skills.sh page as the repository and Skill it is about", () => {
    expect(
      parseSkillLocator("https://skills.sh/vercel-labs/agent-skills/react-best-practices"),
    ).toEqual(gh("vercel-labs/agent-skills", { skills: ["react-best-practices"] }));
    expect(parseSkillLocator("https://skills.sh/vercel-labs/agent-skills")).toEqual(
      gh("vercel-labs/agent-skills"),
    );
  });

  it("keeps a download and an unknown site apart from a repository", () => {
    for (const url of [
      "https://github.com/acme/skills/archive/refs/heads/main.zip",
      "https://github.com/acme/skills/releases/download/v1/skills.zip",
      "https://codeload.github.com/acme/skills/zip/HEAD",
      "https://gitlab.com/g/skills/-/archive/main/skills-main.zip",
      "https://example.com/skills/deploy/SKILL.md",
      "https://example.com/bundle.tar.gz",
      "https://raw.githubusercontent.com/acme/skills/main/bundle.zip",
    ]) {
      expect(parseSkillLocator(url)).toEqual({ kind: "download", url, skills: [] });
    }
    expect(parseSkillLocator("https://example.com/docs/")).toEqual({
      kind: "url",
      url: "https://example.com/docs",
      skills: [],
    });
    expect(parseSkillLocator("https://git.example.com/team/skills")).toEqual({
      kind: "url",
      url: "https://git.example.com/team/skills",
      skills: [],
    });
  });

  it("takes a local path as it is, `~` included", () => {
    expect(parseSkillLocator("/srv/skills")).toEqual({
      kind: "path",
      path: "/srv/skills",
      skills: [],
    });
    expect(parseSkillLocator("./skills")).toEqual({ kind: "path", path: "./skills", skills: [] });
    expect(parseSkillLocator("~/skills#x")).toEqual({
      kind: "path",
      path: "~/skills#x",
      skills: [],
    });
  });

  it("refuses what no installer would take", () => {
    for (const bad of [
      "",
      "anthropics",
      "a/../b",
      "owner/repo/../x",
      "ftp://x/y/z",
      "https://github.com/acme",
      "a/b#bad~ref",
      "npx skills add",
    ]) {
      expect(parseSkillLocator(bad)).toBeNull();
    }
  });

  it("reads the install command a README says to run, whichever CLI it names", () => {
    expect(
      parseSkillLocator("npx skills add vercel-labs/agent-skills --skill react-best-practices -y"),
    ).toEqual(gh("vercel-labs/agent-skills", { skills: ["react-best-practices"] }));
    expect(
      parseSkillLocator(
        "$ npx -y skills@latest add acme/skills -s 'a, b' --skill=c --agent claude-code -g",
      ),
    ).toEqual(gh("acme/skills", { skills: ["a", "b", "c"] }));
    expect(
      parseSkillLocator(
        "npx skills-installer install @anthropics/skills/frontend-design --client shared -p",
      ),
    ).toEqual(gh("anthropics/skills", { subpath: "frontend-design" }));
    expect(
      parseSkillLocator("bunx add-skill https://github.com/acme/skills/tree/main/skills --all"),
    ).toEqual(gh("acme/skills", { ref: "main", subpath: "skills" }));
    expect(parseSkillLocator("pnpm dlx skills add acme/skills --skill '*' --branch v2")).toEqual(
      gh("acme/skills", { ref: "v2" }),
    );
    expect(parseSkillLocator("skills add ./local-skills --copy")).toEqual({
      kind: "path",
      path: "./local-skills",
      skills: [],
    });
  });
});

describe("splitCommandLine", () => {
  it("splits on whitespace, keeping a quoted word whole", () => {
    expect(splitCommandLine(`npx skills add a/b --skill "x y" -s 'z'`)).toEqual([
      "npx",
      "skills",
      "add",
      "a/b",
      "--skill",
      "x y",
      "-s",
      "z",
    ]);
  });
});

describe("skillMatchesRequest", () => {
  it("matches by library name or directory name, case aside, and everything when nothing was asked", () => {
    const skill = { name: "react-best-practices", relativePath: "skills/React-Best-Practices" };
    expect(skillMatchesRequest([], skill)).toBe(true);
    expect(skillMatchesRequest(["react-best-practices"], skill)).toBe(true);
    expect(skillMatchesRequest(["react-best-practices"], { ...skill, relativePath: "." })).toBe(
      true,
    );
    expect(skillMatchesRequest(["deploy"], skill)).toBe(false);
  });
});
