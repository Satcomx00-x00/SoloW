import { z } from "zod";

/**
 * Agent widgets: structured things an agent asks the frontend to *render*, rather than more text
 * in the transcript.
 *
 * The problem this solves is that a coding agent's only output channel is prose. Anything richer
 * — a question with tappable answers, a diagram, a checklist of what it is about to do — either
 * arrives as ASCII art or does not arrive at all. A widget is that same intent expressed as data
 * the client can draw properly, and answer.
 *
 * Three properties are deliberate:
 *
 * **Agent-agnostic.** Nothing here mentions Claude Code, ACP, or MCP. A widget is produced by
 * whichever adapter recognises one (today: a fenced block in assistant output, parsed in the
 * orchestrator) and every producer funnels through `parseWidget`, so a second agent protocol
 * adds a producer, not a second vocabulary.
 *
 * **Bounded.** Every string has a length, every list a maximum. These payloads are appended to
 * the durable session log and replayed on reconnect: an unbounded `content` would let one turn
 * of agent output become the transcript's whole weight (Principle IV's neighbour — the log is
 * evidence, and evidence has to stay readable).
 *
 * **Forward-compatible.** `WIDGET_CATALOG` names every widget in the agreed set, including the
 * ones not built yet, and `parseWidget` turns an unrecognised or malformed emission into the
 * `unsupported` variant instead of throwing it away. An agent that asks for a `weather` card
 * today gets a row saying so — which is the difference between "not built yet" and "your output
 * vanished".
 */

/** Longest `show_widget` body accepted, in characters. A diagram, not a document. */
export const MAX_WIDGET_CONTENT = 64 * 1024;

/**
 * Fields a person reads, and how much of one this build will show.
 *
 * The bug that forced this table is worth stating. An agent asked a real question — five options,
 * each a sentence describing what it proposed to do — and one label came to 240 characters against
 * a 200-character cap. The schema did what a strict schema tells it to: the whole widget failed,
 * degraded to `unsupported`, and the operator was left looking at a card with no options while the
 * run sat blocked on an answer that could no longer be given. A cap meant to keep the log readable
 * had instead deleted the question.
 *
 * So the limits still exist and still bound what reaches the log — they just resolve an overflow
 * by trimming the tail rather than by discarding the sentence it was in. The ellipsis is the
 * honest part: it says the text was cut, where a silent slice would let a reader believe they had
 * read the whole option.
 *
 * Keyed by field name and applied by `clipDisplayText` *before* validation, rather than as a
 * `.transform()` on each field. That was the first shape and it was wrong for a reason worth
 * recording: a `ZodEffects` cannot be rendered into an OpenAPI schema, so every field carrying one
 * broke `openapi:gen` for the whole `session.get` response. A schema that quietly rewrites its own
 * input is also the more surprising design — this way the schemas stay declarative and the one
 * place that already normalises an agent's emission does the clipping too.
 *
 * Two kinds of field are deliberately absent from the table. An option `id` must survive intact or
 * the answer stops matching what was offered; `show_widget.content` is markup, and a clipped SVG is
 * a broken one. For those, refusing remains the honest outcome.
 */
const DISPLAY_LIMITS: Record<string, number> = {
  prompt: 1000,
  title: 200,
  label: 500,
  description: 1000,
  note: 300,
  badge: 40,
  path: 400,
  requested: 120,
  reason: 500,
};

/**
 * The declared length of a readable field, read straight off the table above so the schema and
 * the clip can never disagree about what "fits". Because `clipDisplayText` runs first, this bound
 * is always already satisfied — it is here to keep the schema honest about what it stores, which
 * is what the "every string has a length" rule at the top of this file is for.
 */
function fits(field: keyof typeof DISPLAY_LIMITS): number {
  return DISPLAY_LIMITS[field] as number;
}

/**
 * Clip every readable string in an emission to what its field will show.
 *
 * Recursive, because the fields that overflow in practice are nested — an option's `label`, a
 * step's `note`, a file's `path` — and walking by key name reaches all of them without this
 * function having to know the shape of a widget it has not seen yet.
 */
function clipDisplayText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clipDisplayText);
  if (typeof value !== "object" || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const limit = DISPLAY_LIMITS[key];
    out[key] =
      typeof inner === "string" && limit !== undefined && inner.length > limit
        ? `${inner.slice(0, limit - 1)}…`
        : clipDisplayText(inner);
  }
  return out;
}

/**
 * Every widget name in the catalog, and whether this build draws it.
 *
 * The list is the agreement; `status` is the progress against it. A `planned` entry is not a
 * gap in this file — it is a schema variant and a renderer that have not been written, and
 * `parseWidget` reports exactly that when one arrives.
 */
export const WIDGET_CATALOG = {
  // Elicitation.
  ask_user_input: { family: "elicitation", status: "implemented" },
  // Visualizer.
  show_widget: { family: "visualizer", status: "implemented" },
  // Cards.
  options_card: { family: "cards", status: "implemented" },
  step_card: { family: "cards", status: "implemented" },
  featured_card: { family: "cards", status: "planned" },
  product_carousel: { family: "cards", status: "planned" },
  comparison_card: { family: "cards", status: "planned" },
  link_preview: { family: "cards", status: "planned" },
  // Domain.
  places_map: { family: "domain", status: "planned" },
  places_list: { family: "domain", status: "planned" },
  itinerary: { family: "domain", status: "planned" },
  recipe: { family: "domain", status: "planned" },
  quiz: { family: "domain", status: "planned" },
  weather: { family: "domain", status: "planned" },
  message_compose: { family: "domain", status: "planned" },
  image_search: { family: "domain", status: "planned" },
  // Meta / install.
  present_files: { family: "meta", status: "implemented" },
  suggest_connectors: { family: "meta", status: "planned" },
  suggest_plugin_install: { family: "meta", status: "planned" },
  suggest_skills: { family: "meta", status: "planned" },
  recommend_claude_apps: { family: "meta", status: "planned" },
  suggest_research: { family: "meta", status: "planned" },
} as const satisfies Record<string, { family: string; status: "implemented" | "planned" }>;

export type WidgetName = keyof typeof WIDGET_CATALOG;
export const WIDGET_NAMES = Object.keys(WIDGET_CATALOG) as WidgetName[];

/** One choice offered by an elicitation or a card. */
export const widgetOptionSchema = z.object({
  /** Structural: the answer names this back, so it is bounded strictly and never clipped. */
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(fits("label")),
  description: z.string().max(fits("description")).optional(),
});
export type WidgetOption = z.infer<typeof widgetOptionSchema>;

/**
 * A question with tappable answers (`ask_user_input_v0`).
 *
 * `mode` is what the client renders and what the response has to satisfy: one of, several of, or
 * all of them in an order. The agent never gets to invent an option after the fact — the answer
 * is validated against this list on the way back, the same rule the permission channel already
 * holds (an agent's own options, in the agent's own order, and nothing else).
 */
export const askUserInputWidget = z.object({
  kind: z.literal("ask_user_input"),
  prompt: z.string().min(1).max(fits("prompt")),
  mode: z.enum(["single", "multi", "rank"]).default("single"),
  options: z.array(widgetOptionSchema).min(1).max(12),
  /** Offer a free-text box alongside the options. */
  allowOther: z.boolean().default(false),
});

/**
 * Rendered markup the agent produced (`show_widget`).
 *
 * `content` is drawn inside a sandboxed iframe by the client, never injected into the app's own
 * DOM: this is markup written by a model, and the transcript it would land in sits beside a
 * repository, a diff, and an operator's session. `module` says what it *is* — the renderer uses
 * it for framing and for whether scripts are allowed to run at all.
 */
export const showWidgetWidget = z.object({
  kind: z.literal("show_widget"),
  module: z.enum(["diagram", "chart", "data_viz", "mockup", "interactive", "art", "elicitation"]),
  title: z.string().max(fits("title")).optional(),
  format: z.enum(["svg", "html"]),
  content: z.string().min(1).max(MAX_WIDGET_CONTENT),
});

/** A set of choices presented as cards; one is picked (`options_card`). */
export const optionsCardWidget = z.object({
  kind: z.literal("options_card"),
  title: z.string().max(fits("title")).optional(),
  options: z
    .array(widgetOptionSchema.extend({ badge: z.string().max(fits("badge")).optional() }))
    .min(1)
    .max(12),
});

/** A stepper or checklist the agent keeps updated (`step_card`). Presentational — nothing to answer. */
export const stepCardWidget = z.object({
  kind: z.literal("step_card"),
  title: z.string().max(fits("title")).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        label: z.string().min(1).max(fits("label")),
        state: z.enum(["todo", "active", "done", "blocked"]),
        note: z.string().max(fits("note")).optional(),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * Files the agent wants looked at (`present_files`).
 *
 * Paths and annotations only, never contents: the same rule `tool_call.input` follows, for the
 * same reason — a payload that could carry a file body would carry whatever was in it.
 */
export const presentFilesWidget = z.object({
  kind: z.literal("present_files"),
  title: z.string().max(fits("title")).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(fits("path")),
        status: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
        note: z.string().max(fits("note")).optional(),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * An emission this build cannot draw: a catalogued widget that is still `planned`, or a payload
 * that failed its own schema. Produced only by `parseWidget` — an agent never sends this kind.
 *
 * It exists so that a widget nobody implemented yet is *visible*. Dropping it would make the
 * agent's output disappear with no trace anywhere, which is the failure mode this whole path is
 * meant to remove.
 */
export const unsupportedWidget = z.object({
  kind: z.literal("unsupported"),
  /** The name the agent asked for, as it wrote it. */
  requested: z.string().max(fits("requested")),
  /** Why it could not be drawn — a catalogue status, or the first validation failure. */
  reason: z.string().max(fits("reason")),
});

export const widgetSchema = z.discriminatedUnion("kind", [
  askUserInputWidget,
  showWidgetWidget,
  optionsCardWidget,
  stepCardWidget,
  presentFilesWidget,
  unsupportedWidget,
]);
export type Widget = z.infer<typeof widgetSchema>;
export type WidgetKind = Widget["kind"];

/** Widgets that wait on a person. Everything else is drawn and left alone. */
const INTERACTIVE: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  "ask_user_input",
  "options_card",
]);

export function widgetExpectsResponse(widget: Widget): boolean {
  return INTERACTIVE.has(widget.kind);
}

/**
 * The options a widget offers, whatever shape it keeps them in — one place for the answer
 * validator and the renderer to agree on what may be chosen.
 */
export function widgetOptions(widget: Widget): WidgetOption[] {
  if (widget.kind === "ask_user_input" || widget.kind === "options_card") return widget.options;
  return [];
}

/**
 * Read whatever an agent emitted into a widget. Total: it never throws, because the caller is a
 * stream producer that must keep going, and because an emission that cannot be drawn still has
 * to reach the transcript as something.
 *
 * The `kind` is read leniently — `ask_user_input_v0` and `ask_user_input` are the same widget,
 * and an agent copying the catalogue name with its version suffix should not be punished for it.
 */
export function parseWidget(raw: unknown): Widget {
  const asObject = (raw ?? {}) as Record<string, unknown>;
  const rawName = String(asObject["kind"] ?? asObject["type"] ?? asObject["widget"] ?? "");
  const name = normalizeWidgetName(rawName);

  const clipped = clipDisplayText(asObject) as Record<string, unknown>;
  const parsed = widgetSchema.safeParse({ ...clipped, kind: name });
  if (parsed.success) return parsed.data;

  const catalogued = (WIDGET_CATALOG as Record<string, { status: string } | undefined>)[name];
  if (catalogued?.status === "planned") {
    return {
      kind: "unsupported",
      requested: rawName.slice(0, 120),
      reason: "This widget is in the catalogue but not built yet.",
    };
  }
  return {
    kind: "unsupported",
    requested: rawName.slice(0, 120) || "(unnamed)",
    reason: catalogued
      ? (parsed.error.issues[0]?.message ?? "The payload did not match this widget's shape.")
      : "No widget by that name.",
  };
}

/** `ask_user_input_v0` → `ask_user_input`; trims and lowercases the rest. */
export function normalizeWidgetName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[- ]/g, "_")
    .replace(/_v\d+$/, "");
}

/**
 * How an answer is announced to the agent.
 *
 * The agent is not blocked on a fenced widget — it is prose, not a tool call — so the answer
 * reaches it the only way anything reaches a running agent: as a message. That message is echoed
 * back by protocols that echo operator input (ACP does), which put a second, machine-shaped copy
 * of the answer in the transcript directly under the card that already showed it.
 *
 * So the message starts with this marker, and the transcript drops any operator turn carrying it.
 * A marker rather than matching the sentence: the wording is for the model and will change, and a
 * filter that guesses at prose would start showing the noise again the first time it did.
 *
 * The record is not lost — the turn is still in the session log, and the Conversation tab still
 * shows it. What is hidden is a duplicate, in the one view where the widget itself is on screen.
 */
export const WIDGET_ANSWER_PREFIX = "[gatecontrol:widget-response]";

/**
 * An operator's answer to an interactive widget.
 *
 * `values` are option ids — in the order the person put them for `rank`, in any order otherwise.
 * `text` is the free-text box, present only when the widget offered one. Both are validated
 * against the widget that asked, in the orchestrator, before the agent is told anything.
 */
export const widgetResponseSchema = z.object({
  widgetId: z.string().min(1).max(120),
  values: z.array(z.string().min(1).max(120)).max(12),
  text: z.string().max(2000).nullish(),
});
export type WidgetResponse = z.infer<typeof widgetResponseSchema>;

/**
 * Why an answer did not reach the agent. Mirrors the permission channel's vocabulary, because an
 * operator hitting either of these is asking the same question: did my answer land?
 */
export const WidgetErrorCode = {
  /** No widget by that id is waiting — it was answered already, or the run has moved on. */
  NotPending: "WIDGET_NOT_PENDING",
  /** The answer named an option the widget never offered. */
  OptionUnknown: "WIDGET_OPTION_UNKNOWN",
} as const;
export type WidgetErrorCode = (typeof WidgetErrorCode)[keyof typeof WidgetErrorCode];

/**
 * Check an answer against the widget that asked for it. Returns null when it is good.
 *
 * The rule is the permission channel's rule: only the options the agent itself offered, and
 * nothing invented in between. A `single` question takes exactly one; `multi` takes at least
 * one; `rank` takes every option exactly once, which is what makes it a ranking rather than a
 * partial preference.
 */
export function validateWidgetResponse(widget: Widget, response: WidgetResponse): string | null {
  if (!widgetExpectsResponse(widget)) return "This widget does not take an answer.";

  const offered = new Set(widgetOptions(widget).map((o) => o.id));
  for (const value of response.values) {
    if (!offered.has(value)) return `No option "${value}" was offered.`;
  }
  if (new Set(response.values).size !== response.values.length) {
    return "The same option was chosen twice.";
  }

  const mode = widget.kind === "ask_user_input" ? widget.mode : "single";
  const allowOther = widget.kind === "ask_user_input" && widget.allowOther;
  const answeredInText = allowOther && (response.text ?? "").trim().length > 0;

  if (mode === "single" && response.values.length !== 1 && !answeredInText) {
    return "Choose one option.";
  }
  if (mode === "multi" && response.values.length === 0 && !answeredInText) {
    return "Choose at least one option.";
  }
  if (mode === "rank" && response.values.length !== offered.size) {
    return "Rank every option.";
  }
  return null;
}
