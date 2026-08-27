# F20 — Agent Widgets

**Status:** Draft · **Owner:** Platform · **Maturity:** Core · **Last reviewed:** 2026-08-22

## Summary

An agent's only output channel is prose. Anything richer than a sentence — a question with fixed
answers, a diagram, the plan it is about to follow, the six files worth reading out of the forty
it touched — either arrives as ASCII art or does not arrive at all, and anything that needs an
answer arrives as "please reply with 1, 2 or 3" and hopes.

A **widget** is that same intent expressed as data the frontend can draw properly and the
operator can answer by tapping. SoloW defines one agent-agnostic vocabulary
(`@solow/contracts/widget.ts`), one transport (the session log, beside every other record
of a run), and one renderer registry, so a new widget is a schema variant and a component rather
than a change to the stream, the transcript or the agent.

The set is deliberately the same one the Claude app already draws — elicitation, visualizer,
cards, domain widgets, meta/install — so an agent that knows how to ask for a `step_card`
somewhere else asks for the same thing here. `WIDGET_CATALOG` names all of them, including the
ones not built yet; an emission naming a `planned` widget renders as a row saying so rather than
vanishing.

## Jobs served

- **J4 — Watch a process unfold.**
- **J10 — Operate with confidence.**

## User stories

- As an Operator, I want an agent's question to arrive as buttons, so answering it is a tap
  rather than a sentence I have to phrase precisely enough for the model to parse.
- As an Operator, I want to see the plan an agent is following, so "how far along is this" is not
  a question I answer by reading two hundred lines of transcript.
- As a Reviewer, I want the question and the answer kept together in the log, so a finished run
  still shows what was asked and what was decided.

## Functional requirements

- **FR-1** An agent can emit a widget without any protocol support, as a fenced block in its own
  output (` ```solow:widget ` + JSON). Parsed in the orchestrator by `WidgetFenceScanner`,
  which survives arbitrary chunking, removes the block from the prose, and gives up on a block
  that never closes rather than swallowing the transcript behind it.
- **FR-2** Every producer funnels through `parseWidget`, which is total: a malformed payload, an
  unknown name, or a catalogued-but-unbuilt widget becomes the `unsupported` variant carrying the
  reason. An agent's emission is never silently dropped.
- **FR-3** A widget is a session-log record (`widget`), so it replays on reconnect, survives the
  run, and reaches every reader of the log — not only the client that happened to be watching.
- **FR-4** An interactive widget (`ask_user_input`, `options_card`) can be answered from the
  transcript. The answer travels on the same WebSocket channel, under the same signed ticket and
  tenant key, as a permission decision, and is recorded as its own `widget_response` record.
- **FR-5** An answer is validated against the widget that asked: only options the agent itself
  offered, no duplicates, and the arity the mode requires — one for `single`, at least one for
  `multi`, every option exactly once for `rank`. SoloW never invents an option.
- **FR-6** `show_widget` content is rendered inside a sandboxed iframe with no `allow-same-origin`
  and its own restrictive CSP; scripts run only for the modules that mean behaviour
  (`interactive`, `mockup`). Model-written markup never enters the app's own document.
- **FR-7** The feature is behind `ff-agent-widgets`, which governs both halves at once: the brief
  that teaches the agent the fence, and the scanner that reads it. A Workspace with the flag off
  gets a byte-identical brief and an untouched output stream.

## Non-functional requirements

- **NFR-1** Every widget payload is bounded — string lengths, list sizes, and a 64 KiB ceiling on
  `show_widget` content — because these records are appended to the durable log and replayed.
- **NFR-2** Scanning costs nothing when the flag is off and is a single pass over each chunk when
  it is on; a widget adds one row to the transcript, not a re-render of it.

## States & rules

- A widget is drawn as soon as it arrives and stays in the transcript forever; an answer folds
  into the same row rather than adding one.
- Answering is offered only while the run is live. A finished run keeps its widgets as a record,
  including the ones nobody answered — which is itself worth reading.
- Each `step_card` emission is a new row. The log is append-only, and a plan that rewrote its own
  history would destroy the evidence of what the agent believed earlier.

## Edge cases & failure handling

- A block that never closes is released as literal text once it passes the size ceiling.
- An answer naming an unknown widget or an unoffered option is refused with
  `widget_not_pending` / `widget_option_unknown`, kept distinct from the permission channel's
  refusals so the operator is told which question failed to take their answer.
- A `widget_response` whose widget was compacted away is dropped: unlike a tool result, an answer
  says nothing without its question.

## Out of scope (for now)

- **Blocking the agent on an answer.** A fenced widget is prose, so the answer reaches the agent
  as steering rather than as a tool result. Issue #75's task-scoped MCP surface is what turns a
  widget into a call the agent waits on; the contract and the renderers are already shaped for it,
  and adding it is a second producer, not a second vocabulary.
- The `planned` half of `WIDGET_CATALOG` — the domain widgets in particular (`places_map`,
  `weather`, `image_search`) need data sources SoloW does not have.

## Related

- [F11 — Sessions & Conversations](./F11-sessions-conversations.md) — the log these records live in.
- [F19 — Extension Contributions](./F19-extension-contributions.md) — the same registration shape,
  applied to shell surfaces.
- [F09 — Integrated Workspace](./F09-integrated-workspace.md) — the transcript that draws them.
