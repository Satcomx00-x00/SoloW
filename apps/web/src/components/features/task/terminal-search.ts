import type { TranscriptRow } from "./transcript";

/**
 * Finding a string in the transcript, the way an editor or a log viewer does it.
 *
 * Pure and separate from the rendering for the usual reason — the counting, the ordering and the
 * wrap-around are the parts worth testing, and none of them need a DOM.
 *
 * The searchable text of a row is *what the row is about*, not what it happens to draw. A tool
 * call renders as a compact chip, but what someone searching for "pip" wants is the row where
 * the agent ran pip — so a tool row's text is its name and the arguments it was given. Rows that
 * cannot show a highlighted substring (a tool call, a widget, a permission card) still match and
 * are still jumped to; they light up as a row rather than character by character. That asymmetry
 * is deliberate: refusing to match them would make search quietly wrong.
 */

/** The widget a widget row carries — taken from the row type so this module imports no contract. */
type WidgetLike = Extract<TranscriptRow, { kind: "widget" }>["widget"];

/** One occurrence: which row, and which occurrence within that row. */
export interface TranscriptMatch {
  rowId: string;
  /** 0-based occurrence within the row's own text. */
  index: number;
}

/** The text a row is searched by. */
export function rowText(row: TranscriptRow): string {
  switch (row.kind) {
    case "text":
      return row.text;
    case "notice":
      return row.text;
    case "tool": {
      const args = row.input ? Object.values(row.input).join(" ") : "";
      const result = row.result?.output ?? "";
      return [row.name, args, result].filter(Boolean).join(" ");
    }
    case "permission":
      return [row.title, row.toolKind ?? ""].filter(Boolean).join(" ");
    case "widget":
      return widgetText(row.widget);
  }
}

function widgetText(widget: WidgetLike): string {
  switch (widget.kind) {
    case "ask_user_input":
      return [widget.prompt, ...widget.options.map((o) => o.label)].join(" ");
    case "options_card":
      return [widget.title ?? "", ...widget.options.map((o) => o.label)].join(" ");
    case "step_card":
      return [widget.title ?? "", ...widget.steps.map((s) => s.label)].join(" ");
    case "present_files":
      return [widget.title ?? "", ...widget.files.map((f) => f.path)].join(" ");
    case "show_widget":
      // Never the content: that is markup the agent wrote, and matching inside it would send a
      // search for "div" to every diagram in the run.
      return [widget.title ?? "", widget.module].join(" ");
    case "unsupported":
      return `${widget.requested} ${widget.reason}`;
  }
}

/** Whether a row can highlight the matched characters, or only light up whole. */
export function highlightsInline(row: TranscriptRow): boolean {
  return row.kind === "text" || row.kind === "notice";
}

/**
 * Every occurrence of `query`, in transcript order. Case-insensitive, because a log viewer that
 * makes you match the casing of a stack trace is a log viewer nobody uses twice.
 */
export function findMatches(rows: readonly TranscriptRow[], query: string): TranscriptMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const matches: TranscriptMatch[] = [];
  for (const row of rows) {
    const hay = rowText(row).toLowerCase();
    let from = 0;
    let index = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      matches.push({ rowId: row.id, index });
      index += 1;
      from = at + needle.length;
    }
  }
  return matches;
}

/** Step through the matches, wrapping at both ends — `null` when there are none to step through. */
export function stepMatch(count: number, current: number, by: 1 | -1): number | null {
  if (count === 0) return null;
  return (current + by + count) % count;
}

export interface HighlightSegment {
  text: string;
  /** The occurrence number when this segment is a match, or null when it is ordinary text. */
  match: number | null;
}

/**
 * Split a row's text into ordinary and matched segments, numbered so the caller can tell which
 * occurrence is the active one. Returns a single unmatched segment when there is nothing to find,
 * so a caller can render the result unconditionally.
 */
export function splitHighlights(text: string, query: string): HighlightSegment[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [{ text, match: null }];

  const hay = text.toLowerCase();
  const out: HighlightSegment[] = [];
  let from = 0;
  let index = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push({ text: text.slice(from, at), match: null });
    out.push({ text: text.slice(at, at + needle.length), match: index });
    index += 1;
    from = at + needle.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), match: null });
  return out.length > 0 ? out : [{ text, match: null }];
}
