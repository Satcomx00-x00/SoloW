import {
  EMPTY_PROJECT_FILTER,
  type ProjectFilter,
  type ProjectFilterTerm,
} from "@gatecontrol/contracts";

/**
 * The filter language saved views are written in (spec F23 FR-11, issue #129).
 *
 *     status:"In progress" assignee:@me -label:blocked iteration:@current upload
 *
 * Three jobs, kept in one module because they are one grammar: parse text into the serialisable
 * predicate a view stores, print that predicate back as text, and decide whether one row passes
 * it. Nothing here imports React, the DOM, a database or a provider — a filter is data, and the
 * same predicate is evaluated in the browser today and could be pushed into SQL tomorrow without
 * this file changing.
 *
 * The reason a *predicate* is stored rather than the typed string: a string means every reader
 * re-implements the language, and the first reader to disagree with this one — a server-side
 * count, an export, an MCP tool — makes a saved view mean two different things. The reason it is
 * not a closure: a closure cannot be written to a row.
 *
 * Shares its shape with issue #9's label predicate deliberately. One filter model, not two.
 */

/** "Not a literal" — the escape the language uses for the three values it resolves at read time. */
export const FILTER_ME = "@me";
export const FILTER_NONE = "@none";
export const FILTER_CURRENT = "@current";

/**
 * How a field name becomes a filter key: lower-case, everything but letters and digits dropped.
 *
 * So `Target date`, `target-date` and `targetdate` all name the same column. A person typing a
 * filter is naming a column they can see, and making them reproduce its punctuation would be a
 * language that is harder to type than the menu it replaces.
 */
export function normaliseFilterKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Read text into clauses.
 *
 * Unparseable input costs its own token and nothing else: a lone `-`, a `status:` with the value
 * still unwritten, a quote nobody has closed yet. This box is typed into live, so a half-written
 * clause must narrow to *what has been typed*, never to zero rows — a filter that blanks the
 * table on every colon is a filter people stop using.
 */
export function parseProjectFilter(input: string): ProjectFilter {
  const terms: ProjectFilterTerm[] = [];
  let i = 0;

  /** Read one run of characters, honouring quotes, until `stop` says otherwise. */
  const segment = (stop: (c: string) => boolean): string => {
    let out = "";
    while (i < input.length) {
      const c = input[i] as string;
      if (c === '"') {
        i++;
        while (i < input.length && input[i] !== '"') {
          // `\"` and `\\` are the only escapes. Without them a value holding a quote could not
          // survive being printed and read back, and the round-trip is an acceptance criterion.
          if (input[i] === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
            out += input[i + 1];
            i += 2;
            continue;
          }
          out += input[i];
          i++;
        }
        // An unterminated quote ends at the end of the input rather than voiding the clause.
        i++;
        continue;
      }
      if (stop(c)) break;
      out += c;
      i++;
    }
    return out;
  };

  while (i < input.length) {
    const c = input[i] as string;
    if (isSpace(c)) {
      i++;
      continue;
    }

    let negated = false;
    if (c === "-") {
      negated = true;
      i++;
    }

    const head = segment((ch) => isSpace(ch) || ch === ":");

    if (input[i] === ":") {
      i++;
      const values: string[] = [];
      for (;;) {
        const value = segment((ch) => isSpace(ch) || ch === ",");
        if (value !== "") values.push(value);
        if (input[i] === ",") {
          i++;
          continue;
        }
        break;
      }
      // Guarded on the *normalised* key, not the raw one: `!!!` is a non-empty head that
      // normalises to an empty string, and a term with an empty field is one the contract schema
      // refuses — so it would be dropped on save, silently, after the filter had already narrowed
      // the table on screen. The two must agree about what a clause is.
      const field = normaliseFilterKey(head);
      if (field !== "" && values.length > 0) {
        terms.push({ kind: "field", negated, field, values });
      }
      continue;
    }

    if (head !== "") terms.push({ kind: "keyword", negated, text: head });
  }

  return terms.length > 0 ? { terms } : EMPTY_PROJECT_FILTER;
}

/** Quote a word the scanner would otherwise read as two, or as something else entirely. */
function quote(value: string): string {
  // `@me`, `@none` and `@current` are printed bare: quoting them would not make them literal —
  // they are resolved from the parsed value, not from its spelling — so a value that genuinely
  // reads `@me` is a value this language cannot express. Recorded rather than half-solved.
  const needs = value === "" || value.startsWith("-") || /[\s:,"\\]/.test(value);
  if (!needs) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Print a predicate as the text that parses back to it.
 *
 * The filter box shows this, so a view saved from a menu can be edited as text and a view typed
 * as text can be reopened tomorrow. `parseProjectFilter(formatProjectFilter(f))` returns `f` for
 * every `f` this module produces — the guarantee that lets a view survive storage intact.
 */
export function formatProjectFilter(filter: ProjectFilter): string {
  return filter.terms
    .map((term) => {
      const sign = term.negated ? "-" : "";
      if (term.kind === "keyword") return `${sign}${quote(term.text)}`;
      return `${sign}${quote(term.field)}:${term.values.map(quote).join(",")}`;
    })
    .join(" ");
}

/** One row, reduced to what a filter can ask about. Built by the caller from whatever it holds. */
export interface FilterableItem {
  /** Matched by the bare keyword case. The title belongs to the Issue, not to the project row. */
  title: string;
  /**
   * Values by `normaliseFilterKey`ed field name. A list because a cell can hold several —
   * assignees and labels are the ordinary case, not the exception.
   */
  fields: Readonly<Record<string, readonly string[]>>;
}

/**
 * What the three `@` tokens mean *right now*.
 *
 * They stay symbolic in storage on purpose: `assignee:@me` saved by one person has to mean "my
 * items" for whoever opens the tab, and `iteration:@current` has to still mean the current
 * iteration next month. Resolving them at save time would freeze a shared tab into one person's
 * Monday.
 */
export interface ProjectFilterContext {
  /** Who is reading. Null when unknown, and `@me` then matches nothing rather than everything. */
  me?: string | null;
  /** What `@current` resolves to, per filter key — the caller knows which iteration today is in. */
  current?: Readonly<Record<string, readonly string[]>>;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function termMatches(
  term: ProjectFilterTerm,
  item: FilterableItem,
  ctx: ProjectFilterContext,
): boolean {
  if (term.kind === "keyword") {
    return item.title.toLowerCase().includes(term.text.toLowerCase());
  }

  const held = item.fields[term.field] ?? [];
  return term.values.some((value) => {
    if (value === FILTER_NONE) return held.length === 0;
    if (value === FILTER_ME) {
      const me = ctx.me;
      return me ? held.some((h) => eq(h, me)) : false;
    }
    if (value === FILTER_CURRENT) {
      const current = ctx.current?.[term.field] ?? [];
      return current.some((c) => held.some((h) => eq(h, c)));
    }
    return held.some((h) => eq(h, value));
  });
}

/**
 * Does this row pass?
 *
 * Clauses are ANDed and the values inside one clause are ORed, which is the reading the syntax
 * suggests: `status:Todo,Doing size:XL` is "either status, and that size". Negation inverts the
 * clause it is attached to, so `-label:blocked` excludes the blocked rows rather than inverting
 * the whole filter.
 */
export function matchesProjectFilter(
  filter: ProjectFilter,
  item: FilterableItem,
  ctx: ProjectFilterContext = {},
): boolean {
  return filter.terms.every((term) => {
    const hit = termMatches(term, item, ctx);
    return term.negated ? !hit : hit;
  });
}
