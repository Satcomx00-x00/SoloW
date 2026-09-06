/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLibraryErrorCode } from "@solow/contracts";
import { zipSync } from "fflate";
import {
  archiveDirFor,
  cloneDirFor,
  resolveImportRoot,
  scanSkillDirectories,
  unpackSkillArchive,
} from "./skill-import.js";

/**
 * The scan half of a bulk Skill import (spec F24), on a real temp tree: which directories are
 * Skills, what they are called, and that the files beside a SKILL.md are counted as its own.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "solow-skill-import-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function file(path: string, body = "") {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), body);
}

describe("scanSkillDirectories", () => {
  it("finds every directory holding a SKILL.md, however deep, and counts what travels with it", async () => {
    await file(
      "skills/review/SKILL.md",
      "---\nname: Review Checklist\ndescription: How we review\n---\n# R",
    );
    await file("skills/review/scripts/lint.sh", "#!/bin/sh");
    await file("skills/review/references/style.md", "# Style");
    await file(".claude/skills/deploy/SKILL.md", "# Deploy\n\nHow we ship.\n");
    await file("skills/review/nested/SKILL.md", "# not a second skill");
    await file("node_modules/pkg/SKILL.md", "# ignored");
    await file("README.md", "# repo");

    const found = await scanSkillDirectories(root);
    expect(found.map((s) => [s.name, s.description, s.relativePath, s.files])).toEqual([
      ["deploy", "How we ship.", join(".claude", "skills", "deploy"), 1],
      ["review-checklist", "How we review", join("skills", "review"), 4],
    ]);
    expect(found[1]?.path).toBe(join(root, "skills", "review"));
  });

  it("never yields two Skills with one name, and a root that is itself a Skill", async () => {
    await file("a/deploy/SKILL.md", "");
    await file("b/deploy/SKILL.md", "");
    expect((await scanSkillDirectories(root)).map((s) => s.name)).toEqual(["deploy", "deploy-2"]);

    await file("SKILL.md", "---\nname: whole-repo\n---\n");
    const [only] = await scanSkillDirectories(root);
    expect(only?.name).toBe("whole-repo");
    expect(only?.relativePath).toBe(".");
  });

  it("is empty for a tree with no Skills", async () => {
    await file("src/index.ts", "");
    expect(await scanSkillDirectories(root)).toEqual([]);
  });
});

describe("resolveImportRoot", () => {
  it("takes a directory as it is, and refuses a file or a path that is not there", async () => {
    await file("f.txt");
    expect(await resolveImportRoot({ kind: "path", path: root }, join(root, "clones"))).toEqual({
      ok: true,
      data: root,
    });
    expect(await resolveImportRoot({ kind: "path", path: join(root, "f.txt") }, root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportSourceNotFound,
    });
    expect(await resolveImportRoot({ kind: "path", path: join(root, "nope") }, root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportSourceNotFound,
    });
  });

  it("clones a repository into the skills root once, and pulls it forward the next time", async () => {
    const origin = join(root, "origin");
    await mkdir(origin, { recursive: true });
    const sh = async (...args: string[]) => {
      const p = Bun.spawn(["git", ...args], { cwd: origin, stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
    };
    await sh("init", "-q", "-b", "main");
    await sh("config", "user.email", "t@example.com");
    await sh("config", "user.name", "t");
    await mkdir(join(origin, "skills", "deploy"), { recursive: true });
    await writeFile(join(origin, "skills", "deploy", "SKILL.md"), "# Deploy\n");
    await sh("add", ".");
    await sh("commit", "-q", "-m", "one");

    const clones = join(root, "clones");
    const url = `file://${origin}`;
    const first = await resolveImportRoot({ kind: "git", url }, clones);
    expect(first).toEqual({ ok: true, data: cloneDirFor(url, clones) });
    expect((await scanSkillDirectories(first.ok ? first.data : "")).map((s) => s.name)).toEqual([
      "deploy",
    ]);

    await mkdir(join(origin, "skills", "review"), { recursive: true });
    await writeFile(join(origin, "skills", "review", "SKILL.md"), "# Review\n");
    await sh("add", ".");
    await sh("commit", "-q", "-m", "two");
    const second = await resolveImportRoot({ kind: "git", url }, clones);
    expect(second).toEqual(first);
    expect((await scanSkillDirectories(second.ok ? second.data : "")).map((s) => s.name)).toEqual([
      "deploy",
      "review",
    ]);
  });

  it("refuses what is not a git URL, and a repository it cannot reach", async () => {
    expect(await resolveImportRoot({ kind: "git", url: "not a url" }, root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportCloneFailed,
    });
    expect(
      await resolveImportRoot({ kind: "git", url: `file://${join(root, "missing")}` }, root),
    ).toEqual({ ok: false, error: AgentLibraryErrorCode.ImportCloneFailed });
  });
});

describe("cloneDirFor", () => {
  it("names the clone after the repository's owner and name, for every URL shape", () => {
    expect(cloneDirFor("https://github.com/Acme/Skills.git", "/r")).toBe("/r/acme-skills");
    expect(cloneDirFor("git@github.com:acme/skills.git", "/r")).toBe("/r/acme-skills");
    expect(cloneDirFor("https://gitlab.example/group/sub/skills/", "/r")).toBe("/r/sub-skills");
  });
});

describe("unpackSkillArchive", () => {
  const text = (s: string) => new TextEncoder().encode(s);

  it("unpacks an archive under its own name and finds the Skills in it, scripts included", async () => {
    const zip = zipSync({
      "team-skills/skills/review/SKILL.md": text(
        "---\nname: review\ndescription: How we review\n---\n",
      ),
      "team-skills/skills/review/scripts/lint.sh": text("#!/bin/sh"),
      "team-skills/README.md": text("# skills"),
    });
    const out = await unpackSkillArchive("Team Skills.zip", zip, root);
    expect(out).toEqual({ ok: true, data: join(root, "team-skills") });
    const found = await scanSkillDirectories(join(root, "team-skills"));
    expect(found.map((s) => [s.name, s.files])).toEqual([["review", 2]]);
    expect(
      await readFile(
        join(root, "team-skills", "team-skills", "skills", "review", "scripts", "lint.sh"),
        "utf8",
      ),
    ).toBe("#!/bin/sh");
  });

  it("replaces the previous unpack of the same archive, and copes with an archive that is one Skill", async () => {
    await unpackSkillArchive("deploy.zip", zipSync({ "old/SKILL.md": text("# old") }), root);
    await unpackSkillArchive(
      "deploy.zip",
      zipSync({ "SKILL.md": text("# Deploy\n\nShip it.\n") }),
      root,
    );
    const found = await scanSkillDirectories(join(root, "deploy"));
    expect(found.map((s) => [s.name, s.description, s.relativePath])).toEqual([
      ["deploy", "Ship it.", "."],
    ]);
    await expect(stat(join(root, "deploy", "old"))).rejects.toThrow();
  });

  it("refuses an archive that reaches outside its directory, a non-archive, and an empty one", async () => {
    const slip = zipSync({ "../evil/SKILL.md": text("x"), "ok/SKILL.md": text("y") });
    expect(await unpackSkillArchive("slip.zip", slip, root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportArchiveInvalid,
    });
    await expect(stat(join(root, "slip"))).rejects.toThrow();
    await expect(stat(join(root, "evil"))).rejects.toThrow();
    expect(await unpackSkillArchive("nope.zip", text("not a zip at all"), root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportArchiveInvalid,
    });
    expect(await unpackSkillArchive("empty.zip", zipSync({}), root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportArchiveInvalid,
    });
  });

  it("names the directory after the file, without the extension or anything odd", () => {
    expect(archiveDirFor("My Skills (v2).ZIP", "/r")).toBe("/r/my-skills-v2");
    expect(archiveDirFor("/tmp/upload/../x.zip", "/r")).toBe("/r/x");
  });
});
