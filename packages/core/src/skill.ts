/**
 * Reading a `SKILL.md` the way both agent runtimes do (spec F24): YAML-ish frontmatter with a
 * `name` and a `description`, then the playbook itself.
 *
 * Deliberately not a YAML parser. The two keys a Skill needs are one-line scalars, and an author
 * who wrote a nested value in there wrote something no runtime reads either. Anything this does
 * not understand is left in the body rather than guessed at.
 */
export type SkillFrontmatter = {
  name: string | null;
  description: string | null;
  /** The markdown after the frontmatter block, or the whole text when there was none. */
  body: string;
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function readSkillFrontmatter(markdown: string): SkillFrontmatter {
  const text = markdown.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { name: null, description: null, body: text };
  const fields = new Map<string, string>();
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv?.[1]) continue;
    const value = (kv[2] ?? "").trim();
    // A block scalar (`>`, `|`, with an optional chomping sign) is the lines indented under the
    // key — the way most published Skills write a description longer than one line. Folded to
    // one line either way: a description is a sentence in the library, not a document.
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s+\S/.test(lines[i + 1] ?? "") || (lines[i + 1] ?? "").trim() === "")
      ) {
        block.push((lines[++i] ?? "").trim());
      }
      fields.set(kv[1].toLowerCase(), block.join(" ").replace(/\s+/g, " ").trim());
      continue;
    }
    fields.set(kv[1].toLowerCase(), unquote(value));
  }
  return {
    name: fields.get("name") || null,
    description: fields.get("description") || null,
    body: text.slice(match[0].length),
  };
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1).replace(/\\"/g, '"').trim();
  }
  return v;
}

/**
 * A library name out of whatever a Skill or its directory was called: lower-case, dashes for
 * everything else, trimmed to the 64 characters the name schema allows. Empty when nothing
 * survives, so the caller can fall back rather than import a Skill called `-`.
 */
export function skillSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function isSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * What an imported Skill is called and what it says it is for, in that order of preference: the
 * frontmatter, then the directory's name and the first line of prose, then the path it came
 * from — so every detected Skill can be imported without being edited first.
 */
export function describeSkill(
  markdown: string,
  directoryName: string,
  relativePath: string,
): { name: string; description: string } {
  const fm = readSkillFrontmatter(markdown);
  const name = skillSlug(fm.name ?? "") || skillSlug(directoryName) || "skill";
  const prose = fm.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) =>
        line && !line.startsWith("#") && !line.startsWith("<!--") && !/^[-*_]{3,}$/.test(line),
    );
  const description = (fm.description ?? prose ?? `Imported from ${relativePath}`)
    .replace(/\s+/g, " ")
    .trim();
  return { name, description: description.slice(0, 500) };
}
