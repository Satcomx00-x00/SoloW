/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLibraryErrorCode } from "@solow/contracts";
import { gzipSync, zipSync } from "fflate";
import {
  archiveDirFor,
  archiveUrlsFor,
  cloneDirFor,
  parseRepositoryUrl,
  resolveImportSource,
  resolveSkillLocator,
  scanSkillDirectories,
  unpackSkillArchive,
  untar,
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

describe("resolveImportSource", () => {
  it("takes a directory as it is, and refuses a file or a path that is not there", async () => {
    await file("f.txt");
    expect(await resolveImportSource({ kind: "path", path: root }, join(root, "clones"))).toEqual({
      ok: true,
      data: { root, skills: [] },
    });
    expect(await resolveImportSource({ kind: "path", path: join(root, "f.txt") }, root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportSourceNotFound,
    });
    expect(await resolveImportSource({ kind: "path", path: join(root, "nope") }, root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportSourceNotFound,
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
    const first = await resolveImportSource({ kind: "git", url }, clones, fetchImpl);
    // The forge's `repo-ref/` wrapper is stepped into: the root is the tree itself.
    expect(first).toEqual({
      ok: true,
      data: { root: join(clones, "acme-skills", "skills-main"), skills: [] },
    });
    expect(served).toEqual(["https://codeload.github.com/Acme/Skills/zip/HEAD"]);
    expect((await scanSkillDirectories(join(clones, "acme-skills"))).map((s) => s.name)).toEqual([
      "deploy",
    ]);

    archive = zipSync({
      "skills-main/skills/deploy/SKILL.md": text("# Deploy\n"),
      "skills-main/skills/review/SKILL.md": text("# Review\n"),
    });
    const second = await resolveImportSource(
      { kind: "git", url: `${url}#main` },
      clones,
      fetchImpl,
    );
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
    const out = await resolveImportSource(
      { kind: "git", url: "git@git.example.com:team/skills.git" },
      root,
      fetchImpl,
    );
    expect(out).toEqual({ ok: true, data: { root: join(root, "team-skills"), skills: [] } });
    expect(served).toEqual([
      "https://git.example.com/team/skills/-/archive/HEAD/skills-HEAD.zip",
      "https://git.example.com/team/skills/archive/HEAD.zip",
    ]);
  });

  it("refuses what is not a repository URL, and a repository it cannot fetch", async () => {
    expect(await resolveImportSource({ kind: "git", url: "not a url" }, root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportCloneFailed,
    });
    expect(await resolveImportSource({ kind: "git", url: "/srv/skills" }, root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportCloneFailed,
    });
    const gone = fetchOf(async () => new Response("", { status: 404 }));
    expect(
      await resolveImportSource(
        { kind: "git", url: "https://github.com/acme/missing" },
        root,
        gone,
      ),
    ).toEqual({ ok: false, error: HarnessLibraryErrorCode.ImportCloneFailed });
    const garbage = fetchOf(async () => new Response("<html>", { status: 200 }));
    expect(
      await resolveImportSource(
        { kind: "git", url: "https://github.com/acme/html" },
        root,
        garbage,
      ),
    ).toEqual({ ok: false, error: HarnessLibraryErrorCode.ImportCloneFailed });
    expect(await resolveImportSource({ kind: "locator", locator: "anthropics" }, root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportLocatorInvalid,
    });
  });

  const text = (t: string) => new TextEncoder().encode(t);
  const checkout = () =>
    zipSync({
      "skills-main/README.md": text("# Skills"),
      "skills-main/skills/deploy/SKILL.md": text("---\nname: deploy\ndescription: Ship\n---\n"),
      "skills-main/skills/review/SKILL.md": text("# Review\n\nHow we review.\n"),
      "skills-main/skills/review/scripts/check.sh": text("#!/bin/sh"),
    });

  it("steps into the directory a /tree/ URL or owner/repo/path names, and keeps the Skills a locator asks for", async () => {
    const served: string[] = [];
    const fetchImpl = fetchOf(async (input) => {
      served.push(String(input));
      return zipResponse(checkout());
    });
    const tree = await resolveImportSource(
      { kind: "locator", locator: "https://github.com/acme/skills/tree/v2/skills/review" },
      root,
      fetchImpl,
    );
    expect(tree).toEqual({
      ok: true,
      data: { root: join(root, "acme-skills", "skills-main", "skills", "review"), skills: [] },
    });
    expect(served).toEqual(["https://codeload.github.com/acme/skills/zip/v2"]);

    // The whole command, as a README prints it: the repository, and `--skill` narrowing it.
    const command = await resolveImportSource(
      { kind: "locator", locator: "npx skills add acme/skills --skill deploy -y" },
      root,
      fetchImpl,
    );
    expect(command).toEqual({
      ok: true,
      data: { root: join(root, "acme-skills", "skills-main"), skills: ["deploy"] },
    });

    // skills-installer's `owner/repo/skill`: not a directory at the root, so its parent is
    // scanned and the name kept — the same answer as `--skill deploy`.
    const short = await resolveImportSource(
      { kind: "locator", locator: "acme/skills/deploy" },
      root,
      fetchImpl,
    );
    expect(short).toEqual(command);

    // A directory that is nowhere in the checkout is said so, not scanned from the top.
    expect(
      await resolveImportSource(
        { kind: "locator", locator: "acme/skills/nowhere/at-all" },
        root,
        fetchImpl,
      ),
    ).toEqual({ ok: false, error: HarnessLibraryErrorCode.ImportSourceNotFound });
  });

  it("fetches a lone SKILL.md into a directory named after the one it sat in, and an archive under its own name", async () => {
    const fetchImpl = fetchOf(async (input) => {
      const url = String(input);
      if (url.endsWith("/deploy/SKILL.md")) return new Response("# Deploy\n\nShip it.\n");
      if (url.endsWith(".tar.gz")) {
        return zipResponse(gzipSync(tarOf({ "bundle/triage/SKILL.md": "# Triage\n" })));
      }
      if (url.endsWith("/bad.png")) return zipResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));
      return new Response("", { status: 404 });
    });
    const md = await resolveSkillLocator(
      { kind: "download", url: "https://example.com/skills/deploy/SKILL.md", skills: [] },
      root,
      fetchImpl,
    );
    expect(md).toEqual({ ok: true, data: { root: join(root, "deploy"), skills: [] } });
    expect(await readFile(join(root, "deploy", "SKILL.md"), "utf8")).toBe("# Deploy\n\nShip it.\n");

    const tgz = await resolveSkillLocator(
      { kind: "download", url: "https://example.com/dl/bundle.tar.gz", skills: [] },
      root,
      fetchImpl,
    );
    expect(tgz).toEqual({ ok: true, data: { root: join(root, "bundle"), skills: [] } });
    expect((await scanSkillDirectories(join(root, "bundle"))).map((s) => s.name)).toEqual([
      "triage",
    ]);

    expect(
      await resolveSkillLocator(
        { kind: "download", url: "https://example.com/bad.png", skills: [] },
        root,
        fetchImpl,
      ),
    ).toEqual({ ok: false, error: HarnessLibraryErrorCode.ImportArchiveInvalid });
  });

  it("reads a site's /.well-known/agent-skills/ index, in both its shapes, checking a digest when one is given", async () => {
    const skillMd = text("---\nname: deploy\ndescription: Ship\n---\n");
    const digest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", skillMd)).toString("hex")}`;
    const served: string[] = [];
    const fetchImpl = fetchOf(async (input) => {
      const url = String(input);
      served.push(url);
      const routes: Record<string, Response> = {
        "https://docs.example/.well-known/agent-skills/index.json": Response.json({
          $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
          skills: [
            {
              name: "deploy",
              description: "Ship",
              type: "skill-md",
              url: "deploy/SKILL.md",
              digest,
            },
            { name: "Review Kit", description: "Review", type: "archive", url: "/dl/review.zip" },
            { name: "../evil", description: "", type: "skill-md", url: "evil/SKILL.md" },
          ],
        }),
        "https://docs.example/.well-known/agent-skills/deploy/SKILL.md": zipResponse(skillMd),
        "https://docs.example/dl/review.zip": zipResponse(
          zipSync({ "SKILL.md": text("# Review\n"), "references/style.md": text("# Style") }),
        ),
        "https://docs.example/.well-known/agent-skills/evil/SKILL.md": new Response("# Evil"),
        "https://legacy.example/.well-known/skills/index.json": Response.json({
          skills: [
            {
              name: "triage",
              description: "Triage",
              files: ["SKILL.md", "refs/labels.md", "../../etc/passwd"],
            },
          ],
        }),
        "https://legacy.example/.well-known/skills/triage/SKILL.md": new Response("# Triage\n"),
        "https://legacy.example/.well-known/skills/triage/refs/labels.md": new Response("# Labels"),
      };
      return routes[url] ?? new Response("", { status: 404 });
    });

    const v2 = await resolveSkillLocator(
      { kind: "url", url: "https://docs.example", skills: [] },
      root,
      fetchImpl,
    );
    expect(v2).toEqual({ ok: true, data: { root: join(root, "docs.example"), skills: [] } });
    const found = await scanSkillDirectories(join(root, "docs.example"));
    expect(found.map((s) => [s.name, s.relativePath, s.files])).toEqual([
      ["deploy", "deploy", 1],
      ["evil", "evil", 1],
      ["review-kit", "review-kit", 2],
    ]);

    // A path on the site is probed first, then the origin; the legacy path after the current one.
    served.length = 0;
    const v1 = await resolveSkillLocator(
      { kind: "url", url: "https://legacy.example/docs", skills: ["triage"] },
      root,
      fetchImpl,
    );
    expect(v1).toEqual({
      ok: true,
      data: { root: join(root, "legacy.example"), skills: ["triage"] },
    });
    expect(served.slice(0, 4)).toEqual([
      "https://legacy.example/docs/.well-known/agent-skills/index.json",
      "https://legacy.example/.well-known/agent-skills/index.json",
      "https://legacy.example/docs/.well-known/skills/index.json",
      "https://legacy.example/.well-known/skills/index.json",
    ]);
    expect(served).not.toContain(
      "https://legacy.example/.well-known/skills/triage/../../etc/passwd",
    );
    expect(
      (await scanSkillDirectories(join(root, "legacy.example"))).map((s) => [s.name, s.files]),
    ).toEqual([["triage", 2]]);

    // A wrong digest refuses the whole import: an index that lies is not one to trust in part.
    const lying = fetchOf(async (input) => {
      const url = String(input);
      if (url.endsWith("index.json")) {
        return Response.json({
          skills: [
            {
              name: "deploy",
              description: "",
              type: "skill-md",
              url: "deploy/SKILL.md",
              digest: `sha256:${"0".repeat(64)}`,
            },
          ],
        });
      }
      return url.endsWith("SKILL.md")
        ? new Response("# Deploy")
        : new Response("", { status: 404 });
    });
    expect(
      await resolveSkillLocator(
        { kind: "url", url: "https://liar.example", skills: [] },
        root,
        lying,
      ),
    ).toEqual({ ok: false, error: HarnessLibraryErrorCode.ImportArchiveInvalid });

    // No index anywhere and nothing to download: the URL could not be fetched.
    expect(
      await resolveSkillLocator(
        { kind: "url", url: "https://nothing.example/x", skills: [] },
        root,
        fetchImpl,
      ),
    ).toEqual({ ok: false, error: HarnessLibraryErrorCode.ImportCloneFailed });
  });
});

/** A ustar archive of the given files, the plain way, for the reader to undo. */
function tarOf(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = new TextEncoder().encode(body);
    const header = new Uint8Array(512);
    const put = (at: number, s: string) => header.set(new TextEncoder().encode(s), at);
    put(0, name);
    put(100, "0000644\0");
    put(124, `${data.byteLength.toString(8).padStart(11, "0")}\0`);
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    let sum = 0;
    header.fill(0x20, 148, 156);
    for (const b of header) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(
      header,
      data,
      new Uint8Array(Math.ceil(data.byteLength / 512) * 512 - data.byteLength),
    );
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.byteLength, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

describe("untar", () => {
  it("reads regular files, a ustar prefix and a GNU long name, and stops at the end blocks", () => {
    const files = untar(tarOf({ "a/SKILL.md": "# A", "a/scripts/run.sh": "#!/bin/sh\n" }));
    expect(Object.keys(files)).toEqual(["a/SKILL.md", "a/scripts/run.sh"]);
    expect(new TextDecoder().decode(files["a/SKILL.md"])).toBe("# A");
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
      error: HarnessLibraryErrorCode.ImportArchiveInvalid,
    });
    await expect(stat(join(root, "slip"))).rejects.toThrow();
    await expect(stat(join(root, "evil"))).rejects.toThrow();
    expect(await unpackSkillArchive("nope.zip", text("not a zip at all"), root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportArchiveInvalid,
    });
    expect(await unpackSkillArchive("empty.zip", zipSync({}), root)).toEqual({
      ok: false,
      error: HarnessLibraryErrorCode.ImportArchiveInvalid,
    });
  });

  it("names the directory after the file, without the extension or anything odd", () => {
    expect(archiveDirFor("My Skills (v2).ZIP", "/r")).toBe("/r/my-skills-v2");
    expect(archiveDirFor("/tmp/upload/../x.zip", "/r")).toBe("/r/x");
  });
});
