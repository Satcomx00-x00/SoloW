/// <reference types="bun-types" />
import { readFileSync } from "node:fs";
import { COMMIT_TYPES, parseSubject } from "../packages/cli/scripts/next-version.ts";

/**
 * The commit-msg hook (prek, `.pre-commit-config.yaml`): a subject the release can read, or no
 * commit.
 *
 * Two things downstream take the subject at its word. `next-version.ts` decides the release from
 * the types, and git-cliff (`cliff.toml`) writes the changelog from them. A subject that is not a
 * Conventional Commit, or whose type is a typo, is not an error to either — it simply moves no
 * digit and falls into "Other" — so the only place it can be caught is here, before it exists.
 *
 * The parsing is `next-version.ts`'s own (`parseSubject`), not a second pattern: the hook and the
 * release have to agree about what a message says, and the way to make that true is to have one
 * reader.
 */

/** Messages git writes itself, or that a rebase will fold away — not the author's to classify. */
const EXEMPT =
  /^(Merge (branch|remote-tracking branch|pull request) |Revert "|(fixup|squash|amend)! )/;

/** Null when the message is fine; otherwise the sentence to print. */
export function checkCommitMessage(raw: string): string | null {
  // What git keeps under the default `commit.cleanup`: comment lines and the scissors block go.
  const scissors = raw.indexOf("# ------------------------ >8 ------------------------");
  const text = (scissors === -1 ? raw : raw.slice(0, scissors))
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
  const subject = text.split("\n")[0] ?? "";
  if (subject === "") return null; // git aborts an empty message itself
  if (EXEMPT.test(subject)) return null;

  const parsed = parseSubject(text);
  if (parsed === null) {
    return `not a Conventional Commit: "${subject}"\n  expected  <type>(<scope>)?!?: <description>   e.g. fix(task): …`;
  }
  if (!(COMMIT_TYPES as readonly string[]).includes(parsed.type)) {
    return `unknown commit type "${parsed.type}" in "${subject}"\n  one of: ${COMMIT_TYPES.join(", ")}`;
  }
  return null;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun run scripts/check-commit-msg.ts <commit-msg-file>");
    process.exit(2);
  }
  const problem = checkCommitMessage(readFileSync(file, "utf8"));
  if (problem) {
    console.error(`commit-msg: ${problem}`);
    console.error(
      "  The release version (next-version.ts) and CHANGELOG.md (cliff.toml) are both read from this subject.",
    );
    process.exit(1);
  }
}
