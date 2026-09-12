/**
 * The review brief: what the Task was asked, what the harness claims, and what was checked —
 * lined up so a person can answer "may I sign this" without reading four hundred events
 * (review analysis, point 1).
 *
 * Three sources that never referred to each other: the Issue's acceptance criteria (the ask),
 * the harness's `step_card` (its claims, one item per criterion when it is well behaved) and
 * the commands it ran (the checks — a `bun test` in a tool call, with its verdict in the result
 * nobody scrolls to). Everything here is a pure reading of those three; the DAL only gathers
 * them and the panel only draws them, so what "matched", "claimed" and "ran" mean is stated once.
 */

export interface AcceptanceCriterion {
  /** `AC-4`, or `AC-<n>` counted when the Issue numbered nothing. */
  id: string;
  text: string;
  /** True when the Issue's own checkbox was ticked. */
  ticked: boolean;
}

/**
 * The Issue's criteria, in the shapes people actually write them.
 *
 * First the numbered form this repository's Issues use — `- [ ] **AC-4** text` — then any
 * task-list line at all, numbered by position. A description with neither has no criteria, and
 * the brief says so rather than inventing some from prose.
 */
export function parseAcceptanceCriteria(
  description: string | null | undefined,
): AcceptanceCriterion[] {
  if (!description) return [];
  const lines = description.split("\n");
  const numbered: AcceptanceCriterion[] = [];
  const plain: AcceptanceCriterion[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const box = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!box) continue;
    const ticked = box[1] !== " ";
    const body = (box[2] ?? "").trim();
    const tagged = /^\**\s*(AC[-\s]?\d+)\s*\**[:.\s—–-]*\s*(.*)$/i.exec(body);
    if (tagged) {
      numbered.push({
        id: `AC-${(tagged[1] ?? "").replace(/\D/g, "")}`,
        text: (tagged[2] ?? "").replace(/\*\*/g, "").trim(),
        ticked,
      });
    } else {
      plain.push({ id: `AC-${plain.length + 1}`, text: body.replace(/\*\*/g, "").trim(), ticked });
    }
  }
  return numbered.length > 0 ? numbered : plain;
}

export interface Claim {
  label: string;
  state: "todo" | "active" | "done" | "blocked";
  note: string | null;
}

/** The criterion a `step_card` item is about, by the `AC-n` it names — or none. */
export function criterionOfClaim(claim: { id: string; label: string }): string | null {
  const fromId = /^ac[-_]?(\d+)$/i.exec(claim.id.trim());
  if (fromId) return `AC-${fromId[1]}`;
  const fromLabel = /\bAC[-\s]?(\d+)\b/i.exec(claim.label);
  return fromLabel ? `AC-${fromLabel[1]}` : null;
}

/** The changed files a claim's words point at — by basename, which is how a note names them. */
export function filesNamedBy(text: string, files: readonly string[]): string[] {
  const named = new Set<string>();
  for (const path of files) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base.length >= 6 && text.includes(base)) named.add(path);
    else if (text.includes(path)) named.add(path);
  }
  return [...named];
}

export type CheckKind = "test" | "typecheck" | "lint" | "build" | "audit";

export interface Check {
  kind: CheckKind;
  command: string;
  /** The directory the command was run in, when it said so with a leading `cd`. */
  cwd: string | null;
  /** What the output said, in one line — "811 pass / 6 fail", "clean", "errors". */
  verdict: string;
  /** True when it passed, false when it did not, null when the output does not say. */
  passed: boolean | null;
  at: string;
}

const CHECK_KIND: Array<[CheckKind, RegExp]> = [
  ["typecheck", /\b(typecheck|tsc\b|--noEmit)/],
  ["lint", /\b(lint|biome|eslint|ruff|shellcheck)\b/],
  ["audit", /\b(audit|check:[a-z-]+)\b/],
  ["build", /\b(build|compile)\b/],
  ["test", /\b(test|vitest|jest|pytest|playwright|spec)\b/],
];

/** Which check a command is, or null when it is not one — a `cat` is not a verification. */
export function checkKindOf(command: string): CheckKind | null {
  const head = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map((part) => part.trim());
  // The verifying part of a pipeline is the one that names the tool, wherever the `cd` put it.
  for (const [kind, pattern] of CHECK_KIND) {
    if (
      head.some((part) => pattern.test(part) && !/^(cat|sed|grep|ls|head|tail|echo)\b/.test(part))
    )
      return kind;
  }
  return null;
}

/** The directory a `cd X && …` command ran in, or null. */
export function cwdOf(command: string): string | null {
  const m = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(command.trim());
  if (!m) return null;
  return (m[1] ?? "").replace(/^["']|["']$/g, "");
}

/** One line of verdict out of a test, lint or typecheck output. */
export function verdictOf(
  output: string | null | undefined,
  ok: boolean,
): Pick<Check, "verdict" | "passed"> {
  const text = output ?? "";
  const pass = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(text);
  const fail = /(\d+)\s+fail(?:ed|ing|ures?)?\b/i.exec(text);
  if (pass || fail) {
    const p = Number(pass?.[1] ?? 0);
    const f = Number(fail?.[1] ?? 0);
    return { verdict: `${p} pass / ${f} fail`, passed: f === 0 };
  }
  if (/error TS\d+|✖|\berror(s)?\b.*\bfound\b|Found \d+ error/i.test(text)) {
    return { verdict: "errors", passed: false };
  }
  if (/no (issues|errors|problems) found|checked \d+ files|all files pass|clean/i.test(text)) {
    return { verdict: "clean", passed: true };
  }
  if (!ok) return { verdict: "failed", passed: false };
  return { verdict: "ran", passed: null };
}

export interface CriterionRow extends AcceptanceCriterion {
  claim: Claim | null;
  files: string[];
  /** The test files the claim names, and whether any test check ran after the claim. */
  tests: string[];
}

export interface ReviewBrief {
  criteria: CriterionRow[];
  /** Claims that name no criterion — the harness's own checklist items. */
  unmatched: Claim[];
  checks: Check[];
}

export function buildReviewBrief(input: {
  description: string | null | undefined;
  steps: ReadonlyArray<{
    id: string;
    label: string;
    state: Claim["state"];
    note?: string | undefined;
  }>;
  files: readonly string[];
  checks: readonly Check[];
}): ReviewBrief {
  const criteria = parseAcceptanceCriteria(input.description);
  const byCriterion = new Map<string, Claim>();
  const unmatched: Claim[] = [];
  for (const step of input.steps) {
    const claim: Claim = { label: step.label, state: step.state, note: step.note ?? null };
    const id = criterionOfClaim(step);
    if (id && !byCriterion.has(id)) byCriterion.set(id, claim);
    else if (!id) unmatched.push(claim);
  }
  const rows: CriterionRow[] = criteria.map((criterion) => {
    const claim = byCriterion.get(criterion.id) ?? null;
    const words = claim ? `${claim.label} ${claim.note ?? ""}` : "";
    const files = filesNamedBy(words, input.files);
    return {
      ...criterion,
      claim,
      files,
      tests: files.filter((path) =>
        /(^|\/)(test|tests|spec|__tests__)\/|\.(test|spec)\./.test(path),
      ),
    };
  });
  return { criteria: rows, unmatched, checks: [...input.checks] };
}
