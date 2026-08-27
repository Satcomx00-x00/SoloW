import { MAX_WIDGET_CONTENT, parseWidget, type Widget } from "@solow/contracts";

/**
 * Pull widget emissions out of an agent's prose (see `@solow/contracts/widget.ts`).
 *
 * An agent's only output channel is text, so a widget arrives as a fenced block:
 *
 * ```solow:widget
 * {"kind":"ask_user_input","prompt":"Which database?","options":[…]}
 * ```
 *
 * This is deliberately the *lowest* rung of the ladder — it needs nothing from the agent's
 * protocol, so it works with Claude Code, with any ACP agent, and with an agent that has no tool
 * channel at all. When the task-scoped MCP surface lands (issue #75) a widget will also arrive as
 * a tool call, and it will produce the same `Widget` through the same `parseWidget`: this file is
 * a producer, not a second vocabulary.
 *
 * Three things make it safe to run over a live stream:
 *
 * **Fragments.** Text arrives in pieces and a fence can be split across any number of them, so
 * the scanner holds back the tail of a chunk that could be the start of an opener, and holds an
 * opened block until it closes. Nothing is emitted twice and nothing is reordered.
 *
 * **A block that never closes.** An agent can open a fence and then crash, or simply keep
 * writing. Holding back forever would swallow the rest of the transcript, so once a held block
 * passes `MAX_HELD` it is given up on and released as ordinary text — the operator sees the raw
 * block rather than nothing at all.
 *
 * **A block that is not a widget.** Invalid JSON, or a shape no widget has, becomes the
 * `unsupported` widget carrying the reason. The emission is always visible; what varies is
 * whether it is drawn or explained.
 */

const OPEN = "```solow:widget";
const CLOSE = "```";

/**
 * How much unclosed block to hold before giving up. `MAX_WIDGET_CONTENT` is the largest payload a
 * widget may carry, so anything past it plus a little framing cannot become a valid widget
 * anyway — holding more would only delay text the operator is waiting to read.
 */
const MAX_HELD = MAX_WIDGET_CONTENT + 4096;

export interface FenceOutput {
  /** The prose, with every complete widget block removed. May be empty. */
  text: string;
  /** Widgets closed by this chunk, in the order they appeared. */
  widgets: Widget[];
}

const EMPTY: FenceOutput = { text: "", widgets: [] };

/** The longest suffix of `text` that is also a prefix of `needle` — a fence half-arrived. */
function partialSuffix(text: string, needle: string): number {
  const max = Math.min(text.length, needle.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(needle.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Stateful across a run's text: one scanner per agent stream. Not shared between channels —
 * only assistant output is scanned, because a widget in the model's reasoning is a thought about
 * a widget, not a request to draw one.
 */
export class WidgetFenceScanner {
  private held = "";
  /**
   * A block just closed and the newline that followed it has not arrived yet.
   *
   * Chunk boundaries are the reason this is a flag rather than a slice: fed a character at a
   * time, the "\n" after a closing fence lands in the *next* push, and emitting it would leave
   * a blank line wherever a widget was lifted out.
   */
  private swallowNewline = false;

  push(chunk: string): FenceOutput {
    if (chunk === "") return EMPTY;
    this.held += chunk;
    return this.drain(false);
  }

  /** The stream ended: release whatever is still held, closed or not. */
  flush(): FenceOutput {
    const out = this.drain(true);
    const rest = this.held;
    this.held = "";
    return rest ? { text: out.text + rest, widgets: out.widgets } : out;
  }

  private drain(atEnd: boolean): FenceOutput {
    if (this.swallowNewline && this.held !== "") {
      if (this.held.startsWith("\n")) this.held = this.held.slice(1);
      this.swallowNewline = false;
    }

    let text = "";
    const widgets: Widget[] = [];

    for (;;) {
      const open = this.held.indexOf(OPEN);
      if (open === -1) {
        // No opener in sight. Everything is prose except a tail that might be one arriving.
        const keep = atEnd ? 0 : partialSuffix(this.held, OPEN);
        text += this.held.slice(0, this.held.length - keep);
        this.held = keep === 0 ? "" : this.held.slice(this.held.length - keep);
        return { text, widgets };
      }

      text += this.held.slice(0, open);
      const bodyStart = open + OPEN.length;
      const close = this.held.indexOf(CLOSE, bodyStart);

      if (close === -1) {
        const heldSize = this.held.length - open;
        if (!atEnd && heldSize <= MAX_HELD) {
          // Wait for the rest of the block; the prose before it has already been emitted.
          this.held = this.held.slice(open);
          return { text, widgets };
        }
        // Given up on (or the stream ended mid-block): release it as what it literally is.
        text += this.held.slice(open);
        this.held = "";
        return { text, widgets };
      }

      widgets.push(readBlock(this.held.slice(bodyStart, close)));
      this.held = this.held.slice(close + CLOSE.length);
      // A block is normally written on its own lines; swallow the newline it leaves behind so
      // removing a widget does not leave a blank hole in the prose.
      if (this.held.startsWith("\n")) this.held = this.held.slice(1);
      else this.swallowNewline = true;
    }
  }
}

/** One block's body → a widget. Never throws: an unreadable block is still an emission. */
function readBlock(body: string): Widget {
  const trimmed = body.trim();
  if (trimmed === "") {
    return { kind: "unsupported", requested: "(empty)", reason: "The fenced block was empty." };
  }
  try {
    return parseWidget(JSON.parse(trimmed));
  } catch {
    return {
      kind: "unsupported",
      requested: "(unparsed)",
      reason: "The fenced block was not valid JSON.",
    };
  }
}

/**
 * The instruction an agent needs in order to use any of this, appended to a Task's brief.
 *
 * Kept next to the parser on purpose: the day the fence changes, the sentence that teaches it
 * has to change in the same commit, or every agent keeps emitting the old one.
 */
export const WIDGET_BRIEF_INSTRUCTIONS = [
  "You can render interactive widgets in the operator's UI instead of describing them in prose.",
  "Emit one as a fenced block whose info string is exactly `solow:widget`, containing JSON:",
  "",
  "```solow:widget",
  '{"kind":"ask_user_input","prompt":"Which database?","mode":"single",',
  ' "options":[{"id":"pg","label":"PostgreSQL"},{"id":"sqlite","label":"SQLite"}]}',
  "```",
  "",
  "Available kinds: ask_user_input (single|multi|rank, tappable answers — the operator's reply",
  "comes back to you as a message), show_widget (module diagram|chart|data_viz|mockup|",
  "interactive|art, format svg|html, content = the markup), options_card (pickable cards),",
  "step_card (a checklist you re-emit as work progresses), present_files (paths worth reading),",
  "task_complete (how your run ended — see below).",
  "Emit a widget when it beats prose — a question with fixed answers, a diagram, a plan.",
  "",
  "REQUIRED — before you stop working, emit two widgets, in this order:",
  "",
  "1. A `step_card` listing every item of the brief. Each step takes an `id`, a `label` and a",
  "   `state` of `todo|active|done|blocked`, plus an optional `note` — a `done` boolean is not",
  "   the shape and will be rejected. This is the record of what you actually verified; an item",
  "   you did not check is `todo`, not `done`, and a `blocked` one carries its reason in `note`.",
  "",
  "```solow:widget",
  '{"kind":"step_card","title":"Update packages","steps":[',
  ' {"id":"pin","label":"Pin every real dependency","state":"done"},',
  ' {"id":"imports","label":"Fix the BAIT.py import break","state":"blocked",',
  '  "note":"out of scope for this brief"}]}',
  "```",
  "",
  "2. A `task_complete` stating how the run ended:",
  "   - `changes_ready`  you did the work and it is ready to be reviewed",
  "   - `nothing_to_do`  the brief was already satisfied, or was a question, and you changed nothing",
  "   - `blocked`        you could not finish, and the `summary` says what stopped you",
  "",
  "```solow:widget",
  '{"kind":"task_complete","outcome":"changes_ready","summary":"Pinned 5 dependencies"}',
  "```",
  "",
  "This declaration is what tells the operator your run is finished — nothing else does, and a",
  "run that ends without it is read as having been interrupted. It is a report, not a decision:",
  "it does not approve, merge or close anything. A person opens the review.",
].join("\n");
