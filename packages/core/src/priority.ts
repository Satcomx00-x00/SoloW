/**
 * Reading a priority off an issue's labels.
 *
 * Why this exists: a priority is rarely where a planning tool expects it. GitHub Projects has a
 * `Priority` single-select field, and a great many projects never configure its options — the
 * team writes `prio/p1` on the issue instead, because that is what shows up in the issue list,
 * in search and in a notification. The column then reads empty over a project that has priorities
 * on every row, which is the opposite of what the table is for.
 *
 * SoloW already does exactly this for one provider: GitLab has no field store at all, so
 * `DEFAULT_GITLAB_MAPPING` reads `Priority` out of the `priority::` scoped labels. This is the
 * same idea, provider-neutral, for the case where a field exists but nobody filled it in.
 *
 * The rule that keeps it honest: **a derived priority is never written anywhere.** It is not
 * mirrored, not sent to a provider, and the cell that renders it says which label it came from.
 * The moment it were stored it would become indistinguishable from a value someone actually set,
 * and the next sync would have no way to tell them apart.
 */

/** What one label says about priority, once read. */
export interface DerivedPriority {
  /**
   * Ordering only, 0 = most urgent. Never displayed: `p1` and `high` are the same rank and are
   * still spelled differently, because a team reads its own vocabulary and not this scale.
   */
  rank: number;
  /** How a cell spells it — "P1", "High". Taken from the label, not from a canonical list. */
  name: string;
  /** The label it was read off, verbatim, so the cell can attribute it. */
  label: string;
}

/**
 * Words teams use for a priority, and where each one sits.
 *
 * Deliberately not a synonym table collapsing to three levels: `critical` and `urgent` share a
 * rank because they sort together, and they keep their own spelling because a person wrote one of
 * them and not the other.
 */
const NAMED_RANKS: Record<string, number> = {
  blocker: 0,
  critical: 0,
  immediate: 0,
  highest: 0,
  urgent: 0,
  high: 1,
  important: 1,
  medium: 2,
  moderate: 2,
  normal: 2,
  low: 3,
  minor: 3,
  lowest: 4,
  someday: 4,
  trivial: 4,
};

/** `prio/`, `priority::`, `pri:` … — the scope, however this team punctuates it. */
const SCOPED = /^(?:priority|prio|pri)\s*(?:::|[:/\-_\s])\s*(.+)$/;
/** The other word order: `high priority`, `low-priority`. */
const SUFFIXED = /^(.+?)[\s\-_]priority$/;
/** `p0` … `p9`, with or without a scope in front of it. */
const NUMBERED = /^p?([0-9])$/;

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * One label, read as a priority — or null, which is the answer for almost every label.
 *
 * Null rather than a default rank on purpose. A label this does not recognise is not a low
 * priority; it is not a priority at all, and inventing a rank for it would sort real priorities
 * against noise.
 */
export function priorityFromLabel(label: string): DerivedPriority | null {
  const text = label.trim().toLowerCase();
  if (text === "") return null;

  const scoped = SCOPED.exec(text)?.[1] ?? SUFFIXED.exec(text)?.[1];
  /*
   * An unscoped label has to *be* the priority, not merely contain it. `P1` alone is a convention
   * GitHub itself ships; `perf` and `polish` are not priorities, and a looser rule would read
   * them as one.
   */
  const body = scoped ?? text;

  const digits = NUMBERED.exec(body.replace(/[^a-z0-9]/g, ""));
  if (digits?.[1] !== undefined) {
    // An unscoped bare number needs the `p`: a label called `3` says nothing.
    if (!scoped && !/^p[0-9]$/.test(body)) return null;
    return { rank: Number(digits[1]), name: `P${digits[1]}`, label };
  }

  // Only a scoped label may spell its priority as a word. Unscoped, `high` and `low` are as
  // likely to be about a memory limit or a log level as about a priority.
  if (scoped === undefined) return null;
  const word = body.replace(/[^a-z]/g, "");
  const rank = NAMED_RANKS[word];
  return rank === undefined ? null : { rank, name: capitalise(word), label };
}

/**
 * The priority an issue's labels state, most urgent first.
 *
 * Most urgent rather than first-found: an issue carrying both `prio/p3` and `priority::critical`
 * has been escalated, and reporting the one that happens to sort first alphabetically would hide
 * the escalation. Ties keep the label the provider listed first, so the answer is stable across
 * renders rather than dependent on iteration order.
 */
export function priorityFromLabels(labels: readonly string[]): DerivedPriority | null {
  let best: DerivedPriority | null = null;
  for (const label of labels) {
    const found = priorityFromLabel(label);
    if (found && (best === null || found.rank < best.rank)) best = found;
  }
  return best;
}

/**
 * Is this the column a derived priority belongs in?
 *
 * Matched on the field's name, normalised the way the filter language normalises its keys — the
 * provider's field id says nothing about meaning, and a project whose priority column is called
 * `Prioridad` is not one this can answer for. Showing nothing there is the correct outcome: the
 * table would otherwise put a value in a column on the strength of a guess.
 */
export function isPriorityFieldName(name: string): boolean {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "") === "priority";
}

/**
 * The label set an issue should carry once its priority is changed.
 *
 * The write a provider takes is a **whole label set**, not a patch — so setting a priority means
 * sending every other label back untouched, and the one way this can go wrong is silently dropping
 * `area/web` on the way past. That is what this function exists to make impossible, and what its
 * tests are about.
 *
 * Null clears: the priority label goes and nothing else moves.
 */
export function withPriorityLabel(labels: readonly string[], label: string | null): string[] {
  const kept = labels.filter((name) => priorityFromLabel(name) === null);
  return label === null ? kept : [...kept, label];
}
