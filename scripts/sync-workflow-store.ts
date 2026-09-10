/// <reference types="bun-types" />
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSkillName,
  readSkillFrontmatter,
  type VendoredSkillFormat,
  type VendoredStore,
  WORKFLOW_STORE,
  WORKFLOW_STORE_SOURCES,
} from "@solow/core";

/**
 * Bring the Workflow store's Skills in from the repositories that own them (spec F03).
 *
 *   bun run store:sync     fetch every source named in `WORKFLOW_STORE_SOURCES`, validate,
 *                          and rewrite packages/core/src/workflow-store/vendored.generated.json
 *   bun run store:check    validate the generated file against the manifest and the catalog,
 *                          offline — the CI gate, and what `make verify` runs
 *
 * The text a harness reads is never typed into this repository by hand: Spec Kit, Superpowers
 * and OpenSpec change under their owners, and a copy kept here would be the copy nobody
 * refreshes. So the sync runs where the build runs. A source that cannot be fetched, a file
 * that is not what the manifest says it is, or a generated file that has been edited by hand,
 * fails the run — a store that quietly shipped stale or altered text would be worse than one
 * that refused to build.
 *
 * Fetches go to `raw.githubusercontent.com`, one per file, plus one call per source for the
 * commit the ref resolves to, so the generated file says exactly which upstream revision it
 * holds. `GITHUB_TOKEN` is used when set (CI has one); anonymous otherwise.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_DIR = join(ROOT, "packages/core/src/workflow-store");
export const GENERATED = join(STORE_DIR, "vendored.generated.json");
const LOCAL_SKILLS = join(STORE_DIR, "skills");

/** Body length below which a file is a stub or an error page, not a playbook. */
const MIN_BODY = 200;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

class SyncError extends Error {}

/**
 * A Spec Kit command template as a Skill. `specify init` writes these into an agent's command
 * directory after resolving three placeholders; the same three are resolved here, for a Skill
 * that a harness reads rather than a command it runs:
 *  - `{SCRIPT}` becomes the `sh` script the frontmatter names, when it names one;
 *  - `{ARGS}` becomes `$ARGUMENTS`, the form the body already uses elsewhere;
 *  - `__AGENT__` becomes `claude`, the agent whose command layout the template assumes.
 * The frontmatter's `handoffs` and `scripts` are dropped: they drive a CLI's menu, not a harness.
 */
export function speckitCommandToSkill(
  name: string,
  markdown: string,
): { description: string; body: string } {
  const fm = readSkillFrontmatter(markdown);
  const description = fm.description ?? "";
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  const sh = /^scripts:\s*\r?\n(?:[ \t]+\w+:.*\r?\n)*?[ \t]+sh:\s*(.+)$/m.exec(frontmatter)?.[1];
  const body = fm.body
    .replace(/\{SCRIPT\}/g, sh?.trim() ?? "the project's spec-kit script for this step")
    .replace(/\{ARGS\}/g, "$ARGUMENTS")
    .replace(/__AGENT__/g, "claude");
  return { description, body: `# Spec Kit — ${name.replace(/^speckit-/, "")}\n\n${body.trim()}\n` };
}

/** A `SKILL.md` as a Skill: the description from its frontmatter, the body without it. */
export function skillMarkdownToSkill(markdown: string): { description: string; body: string } {
  const fm = readSkillFrontmatter(markdown);
  return { description: fm.description ?? "", body: `${fm.body.trim()}\n` };
}

export function toSkill(
  format: VendoredSkillFormat,
  name: string,
  markdown: string,
): { description: string; body: string } {
  return format === "speckit-command"
    ? speckitCommandToSkill(name, markdown)
    : skillMarkdownToSkill(markdown);
}

/** What every vendored Skill has to satisfy before it is written, whatever it came from. */
export function validateSkill(name: string, skill: { description: string; body: string }): void {
  if (!isSkillName(name)) throw new SyncError(`${name}: not a library name`);
  if (!skill.description.trim()) throw new SyncError(`${name}: no description in its frontmatter`);
  if (skill.description.length > 500) throw new SyncError(`${name}: description over 500 chars`);
  if (skill.body.length < MIN_BODY)
    throw new SyncError(`${name}: body is ${skill.body.length} chars — a stub or an error page`);
  if (/<!doctype html|<html[\s>]/i.test(skill.body))
    throw new SyncError(`${name}: body is HTML, not markdown`);
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    "User-Agent": "solow-workflow-store-sync",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchText(url: string, accept?: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...githubHeaders(), ...(accept ? { Accept: accept } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new SyncError(`${url}: HTTP ${res.status}`);
  return await res.text();
}

/** The path a manifest entry names, kept inside the tree it belongs to. */
function safeRelative(path: string): string {
  const clean = normalize(path).replace(/\\/g, "/");
  if (clean.startsWith("../") || clean.startsWith("/") || clean.includes("/../")) {
    throw new SyncError(`${path}: escapes its source`);
  }
  return clean;
}

export async function sync(): Promise<VendoredStore> {
  const store: VendoredStore = { generatedAt: new Date().toISOString(), sources: {}, skills: {} };
  for (const source of WORKFLOW_STORE_SOURCES) {
    if (source.kind === "repository") {
      const commit = (
        await fetchText(
          `https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`,
          "application/vnd.github.sha",
        )
      ).trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new SyncError(`${source.id}: could not resolve ${source.ref} to a commit`);
      }
      store.sources[source.id] = {
        repository: `https://github.com/${source.repository}`,
        ref: source.ref,
        commit,
        license: source.license,
      };
      for (const spec of source.skills) {
        const path = safeRelative(spec.path);
        // Read at the resolved commit, not the ref, so every file of a source comes from one
        // revision even if the branch moves while the sync runs.
        const markdown = await fetchText(
          `https://raw.githubusercontent.com/${source.repository}/${commit}/${path}`,
        );
        addSkill(store, source.id, spec.name, path, toSkill(spec.format, spec.name, markdown));
      }
    } else {
      store.sources[source.id] = {
        repository: null,
        ref: null,
        commit: null,
        license: source.license,
      };
      for (const spec of source.skills) {
        const path = safeRelative(spec.path);
        const file = join(LOCAL_SKILLS, path);
        if (!existsSync(file))
          throw new SyncError(`${source.id}: ${path} is not in ${LOCAL_SKILLS}`);
        const markdown = readFileSync(file, "utf8");
        addSkill(store, source.id, spec.name, path, toSkill(spec.format, spec.name, markdown));
      }
    }
  }
  return store;
}

function addSkill(
  store: VendoredStore,
  source: string,
  name: string,
  path: string,
  skill: { description: string; body: string },
): void {
  if (store.skills[name]) throw new SyncError(`${name}: named by two sources`);
  validateSkill(name, skill);
  store.skills[name] = {
    source,
    path,
    description: skill.description.trim(),
    body: skill.body,
    sha256: sha256(skill.body),
  };
}

/** Sorted keys, so a sync with nothing changed upstream rewrites nothing. */
export function serialize(store: VendoredStore): string {
  const sorted: VendoredStore = {
    generatedAt: store.generatedAt,
    sources: Object.fromEntries(
      Object.entries(store.sources).sort(([a], [b]) => a.localeCompare(b)),
    ),
    skills: Object.fromEntries(Object.entries(store.skills).sort(([a], [b]) => a.localeCompare(b))),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * The generated file against the manifest and the catalog, offline. Returns the problems
 * rather than throwing, so a check can list every one at once.
 */
export function check(store: VendoredStore): string[] {
  const problems: string[] = [];
  const expected = new Map<string, { source: string; path: string }>();
  for (const source of WORKFLOW_STORE_SOURCES) {
    for (const spec of source.skills)
      expected.set(spec.name, { source: source.id, path: spec.path });
    if (!store.sources[source.id])
      problems.push(`source ${source.id} is not in the generated file`);
    else if (
      source.kind === "repository" &&
      !/^[0-9a-f]{40}$/.test(store.sources[source.id]?.commit ?? "")
    ) {
      problems.push(`source ${source.id} records no commit`);
    }
  }
  for (const [name, spec] of expected) {
    const skill = store.skills[name];
    if (!skill) {
      problems.push(`${name}: in the manifest, not in the generated file`);
      continue;
    }
    if (skill.source !== spec.source || skill.path !== spec.path) {
      problems.push(
        `${name}: generated from ${skill.source}/${skill.path}, manifest says ${spec.source}/${spec.path}`,
      );
    }
    if (skill.sha256 !== sha256(skill.body))
      problems.push(`${name}: body does not match its sha256 — edited by hand?`);
    try {
      validateSkill(name, skill);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  for (const name of Object.keys(store.skills)) {
    if (!expected.has(name)) problems.push(`${name}: in the generated file, not in the manifest`);
  }
  // Every Skill a catalog Step names has to be here, or the install would bind to nothing.
  for (const entry of WORKFLOW_STORE) {
    for (const name of entry.skills) {
      if (!store.skills[name]) problems.push(`${entry.id}: names ${name}, which is not vendored`);
    }
  }
  return problems;
}

export function readGenerated(): VendoredStore {
  if (!existsSync(GENERATED))
    throw new SyncError(`${GENERATED} is missing — run \`bun run store:sync\``);
  return JSON.parse(readFileSync(GENERATED, "utf8")) as VendoredStore;
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0] ?? "sync";
  if (mode === "check") {
    const problems = check(readGenerated());
    for (const p of problems) console.error(`store:check: ${p}`);
    if (problems.length === 0)
      console.log(`store:check: ok — ${Object.keys(readGenerated().skills).length} skills`);
    return problems.length === 0 ? 0 : 1;
  }
  if (mode !== "sync") {
    console.error("usage: sync-workflow-store.ts [sync|check]");
    return 2;
  }
  const store = await sync();
  const problems = check(store);
  if (problems.length > 0) {
    for (const p of problems) console.error(`store:sync: ${p}`);
    return 1;
  }
  const next = serialize(store);
  // Only the timestamp differs when upstream has not moved: keep the old one, so `git status`
  // stays clean and a scheduled refresh commits only when there is something to commit.
  if (existsSync(GENERATED)) {
    const previous = readFileSync(GENERATED, "utf8");
    const strip = (s: string) => s.replace(/"generatedAt": "[^"]*"/, "");
    if (strip(previous) === strip(next)) {
      console.log("store:sync: up to date");
      return 0;
    }
  }
  writeFileSync(GENERATED, next);
  for (const [id, src] of Object.entries(store.sources)) {
    console.log(`store:sync: ${id} ${src.commit ? `@ ${src.commit.slice(0, 12)}` : "(local)"}`);
  }
  console.log(`store:sync: wrote ${Object.keys(store.skills).length} skills to ${GENERATED}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(
        `store:${process.argv[2] ?? "sync"}: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    },
  );
}
