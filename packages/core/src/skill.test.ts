import { describe, expect, it } from "bun:test";
import { describeSkill, isSkillName, readSkillFrontmatter, skillSlug } from "./skill.js";

describe("readSkillFrontmatter", () => {
  it("reads name and description, quoted or not, and hands back the body", () => {
    const fm = readSkillFrontmatter(
      '---\nname: review-checklist\ndescription: "How we \\"review\\" a change"\nversion: 2\n---\n\n# Review\n\nCheck the tests.\n',
    );
    expect(fm).toEqual({
      name: "review-checklist",
      description: 'How we "review" a change',
      body: "\n# Review\n\nCheck the tests.\n",
    });
  });

  it("treats text with no frontmatter as all body", () => {
    expect(readSkillFrontmatter("# Deploy\n\nRun the script.")).toEqual({
      name: null,
      description: null,
      body: "# Deploy\n\nRun the script.",
    });
    // A rule in the body is not a frontmatter fence.
    expect(readSkillFrontmatter("# T\n\n---\n\ntext").name).toBeNull();
  });

  it("folds a block-scalar description to one line, whichever way it was written", () => {
    const folded = readSkillFrontmatter(
      "---\nname: pdf\ndescription: >\n  Use this skill for PDF files:\n  reading, merging.\n\n  Anything else too.\nlicense: MIT\n---\nbody",
    );
    expect(folded.description).toBe(
      "Use this skill for PDF files: reading, merging. Anything else too.",
    );
    expect(folded.body).toBe("body");
    const literal = readSkillFrontmatter("---\ndescription: |-\n  Line one\n  Line two\n---\n");
    expect(literal.description).toBe("Line one Line two");
  });

  it("copes with CRLF and a BOM", () => {
    const fm = readSkillFrontmatter("﻿---\r\nname: x\r\n---\r\nbody");
    expect(fm.name).toBe("x");
    expect(fm.body).toBe("body");
  });
});

describe("skillSlug", () => {
  it("turns whatever a directory was called into a library name", () => {
    expect(skillSlug("Review Checklist")).toBe("review-checklist");
    expect(skillSlug("  Déploiement_prod (v2) ")).toBe("deploiement-prod-v2");
    expect(skillSlug("---")).toBe("");
    expect(isSkillName(skillSlug("a".repeat(80)))).toBe(true);
  });
});

describe("describeSkill", () => {
  it("prefers the frontmatter, then the directory and first prose line, then the path", () => {
    expect(
      describeSkill("---\nname: Deploy Prod\ndescription: Ship it\n---\n# x", "dir", "a/dir"),
    ).toEqual({
      name: "deploy-prod",
      description: "Ship it",
    });
    expect(
      describeSkill("# Deploy\n\nHow we ship the service.\n", "Deploy Service", "skills/deploy"),
    ).toEqual({
      name: "deploy-service",
      description: "How we ship the service.",
    });
    expect(describeSkill("", "###", "weird/###")).toEqual({
      name: "skill",
      description: "Imported from weird/###",
    });
  });
});
