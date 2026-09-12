import type { DecisionWidget, ReviewDraft, ReviewNote } from "@solow/contracts";

/** The contract's ceiling on `reviewDecisionInput.feedback`. */
export const FEEDBACK_MAX = 10_000;

/** One note's anchor, as a reader — or a harness — would write it: `src/a.ts:12`. */
export function noteAnchor(note: Pick<ReviewNote, "path" | "side" | "line">): string {
  // Old-side lines are the exception and say so; a bare number means the new file.
  return note.side === "old" ? `${note.path}:${note.line} (old)` : `${note.path}:${note.line}`;
}

/**
 * The reviewer's draft as the one string the decision carries (F10 FR-7).
 *
 * The orchestrator forwards `feedback` verbatim into the next round's brief under
 * `# Review feedback`, so this is written for the harness to act on: the general remark first,
 * because it is the point, then each line note with its anchor in the form a harness already
 * reads in compiler output. Notes are grouped by file and sorted by line, which is the order
 * someone fixing them works in — not the order they were written.
 *
 * Repository names are prefixed only on a multi-repository Task, where a bare path is ambiguous.
 * Undefined when there is nothing to say, so the decision goes out exactly as it did before —
 * the orchestrator has its own sentence for "the reviewer left no notes".
 */
export function collateFeedback(
  draft: Pick<ReviewDraft, "notes" | "general">,
  repositoryName?: (repositoryId: string | null) => string | null,
): string | undefined {
  const general = draft.general.trim();
  const notes = [...draft.notes].sort(
    (a, b) =>
      (a.repositoryId ?? "").localeCompare(b.repositoryId ?? "") ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  if (!general && notes.length === 0) return undefined;

  const repositories = new Set(notes.map((n) => n.repositoryId ?? ""));
  const prefix = (note: ReviewNote) => {
    if (repositories.size < 2 || !repositoryName) return "";
    const name = repositoryName(note.repositoryId);
    return name ? `(${name}) ` : "";
  };

  const parts: string[] = [];
  if (general) parts.push(general);
  if (notes.length > 0) {
    parts.push(
      [
        "Notes on specific lines:",
        ...notes.map((note) => `- ${prefix(note)}${noteAnchor(note)} — ${note.text.trim()}`),
      ].join("\n"),
    );
  }
  const text = parts.join("\n\n");
  if (text.length <= FEEDBACK_MAX) return text;
  // Cut at the ceiling rather than refused at the gate: a decision must never be un-takeable
  // because the reviewer wrote too much, and the harness is told the notes were cut.
  const marker = "\n\n[feedback truncated at the limit]";
  return `${text.slice(0, FEEDBACK_MAX - marker.length)}${marker}`;
}

/**
 * The reviewer's decisions as the next Step's harness will read them (point 3): one line per
 * decision, the question, the option taken — in the harness's own words when it was one of the
 * offered ones, the reviewer's when it was "something else" — and whether it overturned the
 * harness's pick, which is the fact the next Step most needs.
 */
export function collateDecisions(
  widgets: readonly DecisionWidget[],
  answers: ReadonlyArray<{ id: string; choice: string; note?: string | undefined }>,
): string | undefined {
  const lines: string[] = [];
  for (const widget of widgets) {
    const answer = answers.find((a) => a.id === widget.id);
    if (!answer) continue;
    const option = widget.options.find((o) => o.id === answer.choice);
    const taken =
      answer.choice === "other"
        ? (answer.note ?? "").trim() || "(the reviewer chose neither option and left no words)"
        : (option?.label ?? answer.choice);
    const stance =
      answer.choice === widget.chosen
        ? "confirmed your choice"
        : `overturned your choice of "${widget.options.find((o) => o.id === widget.chosen)?.label ?? widget.chosen}"`;
    lines.push(`- ${widget.question} → ${taken} (${stance})`);
  }
  return lines.length > 0 ? `Decisions settled by the reviewer:\n${lines.join("\n")}` : undefined;
}

/** Everything the reviewer said, for one decision: notes and remark, then decisions. */
export function joinFeedback(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter((p): p is string => Boolean(p)).join("\n\n");
  if (!text) return undefined;
  return text.length <= FEEDBACK_MAX
    ? text
    : `${text.slice(0, FEEDBACK_MAX - 40)}\n\n[feedback truncated at the limit]`;
}
