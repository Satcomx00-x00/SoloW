/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLibraryErrorCode } from "@solow/contracts";
import { zipSync } from "fflate";
import {
  archiveDirFor,
  archiveUrlsFor,
  cloneDirFor,
  parseRepositoryUrl,
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

  /** A stand-in for `fetch` that answers from a function — the typing is what `typeof fetch` demands. */
  const fetchOf = (fn: (input: RequestInfo | URL) => Promise<Response>) =>
    fn as unknown as typeof fetch;
  const zipResponse = (bytes: Uint8Array) =>
    new Response(new Blob([bytes as unknown as BlobPart]), { status: 200 });

  it("fetches a repository's archive into the skills root, and fetches it again the next time", async () => {
    const text = (t: string) => new TextEncoder().encode(t);
    const served: string[] = [];
    let archive = zipSync({ "skills-main/skills/deploy/SKILL.md": text("# Deploy\n") });
    const fetchImpl = fetchOf(async (input) => {
      served.push(String(input));
      return zipResponse(archive);
    });

    const clones = join(root, "clones");
    const url = "https://github.com/Acme/Skills.git";
    const first = await resolveImportRoot({ kind: "git", url }, clones, fetchImpl);
    expect(first).toEqual({ ok: true, data: join(clones, "acme-skills") });
    expect(served).toEqual(["https://codeload.github.com/Acme/Skills/zip/HEAD"]);
    expect((await scanSkillDirectories(join(clones, "acme-skills"))).map((s) => s.name)).toEqual([
      "deploy",
    ]);

    archive = zipSync({
      "skills-main/skills/deploy/SKILL.md": text("# Deploy\n"),
      "skills-main/skills/review/SKILL.md": text("# Review\n"),
    });
    const second = await resolveImportRoot({ kind: "git", url: `${url}#main` }, clones, fetchImpl);
    expect(second).toEqual(first);
    expect(served[1]).toBe("https://codeload.github.com/Acme/Skills/zip/main");
    expect((await scanSkillDirectories(join(clones, "acme-skills"))).map((s) => s.name)).toEqual([
      "deploy",
      "review",
    ]);
  });

  it("asks a self-hosted forge the GitLab way, then the Gitea way", async () => {
    const served: string[] = [];
    const fetchImpl = fetchOf(async (input) => {
      served.push(String(input));
      return served.length === 1
        ? new Response("not here", { status: 404 })
        : zipResponse(zipSync({ "SKILL.md": new TextEncoder().encode("# One") }));
    });
    const out = await resolveImportRoot(
      { kind: "git", url: "git@git.example.com:team/skills.git" },
      root,
      fetchImpl,
    );
    expect(out).toEqual({ ok: true, data: join(root, "team-skills") });
    expect(served).toEqual([
      "https://git.example.com/team/skills/-/archive/HEAD/skills-HEAD.zip",
      "https://git.example.com/team/skills/archive/HEAD.zip",
    ]);
  });

  it("refuses what is not a repository URL, and a repository it cannot fetch", async () => {
    expect(await resolveImportRoot({ kind: "git", url: "not a url" }, root)).toEqual({
      ok: false,
      error: AgentLibraryErrorCode.ImportCloneFailed,
    });
    const gone = fetchOf(async () => new Response("", { status: 404 }));
    expect(
      await resolveImportRoot({ kind: "git", url: "https://github.com/acme/missing" }, root, gone),
    ).toEqual({ ok: false, error: AgentLibraryErrorCode.ImportCloneFailed });
    const garbage = fetchOf(async () => new Response("<html>", { status: 200 }));
    expect(
      await resolveImportRoot({ kind: "git", url: "https://github.com/acme/html" }, root, garbage),
    ).toEqual({ ok: false, error: AgentLibraryErrorCode.ImportCloneFailed });
  });
});

describe("parseRepositoryUrl / archiveUrlsFor", () => {
  it("reads the URL forms people paste, with an optional #ref", () => {
    expect(parseRepositoryUrl("https://github.com/Acme/Skills.git")).toEqual({
      host: "github.com",
      path: "Acme/Skills",
      name: "Skills",
      ref: "HEAD",
    });
    expect(parseRepositoryUrl("git@gitlab.com:group/sub/skills.git#release/2")).toEqual({
      host: "gitlab.com",
      path: "group/sub/skills",
      name: "skills",
      ref: "release/2",
    });
    expect(parseRepositoryUrl("https://github.com/acme")).toBeNull();
    expect(parseRepositoryUrl("ftp://x/y/z")).toBeNull();
    expect(parseRepositoryUrl("https://github.com/a/b#bad ref")).toBeNull();
  });

  it("knows where each forge keeps its archives", () => {
    expect(archiveUrlsFor({ host: "github.com", path: "a/b", name: "b", ref: "v1" })).toEqual([
      "https://codeload.github.com/a/b/zip/v1",
    ]);
    expect(
      archiveUrlsFor({ host: "gitlab.com", path: "g/s/b", name: "b", ref: "release/2" }),
    ).toEqual([
      "https://gitlab.com/g/s/b/-/archive/release/2/b-release-2.zip",
      "https://gitlab.com/g/s/b/archive/release/2.zip",
    ]);
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
