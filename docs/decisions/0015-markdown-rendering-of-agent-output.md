# 0015 — Render agent output as Markdown with react-markdown

**Status:** Accepted · **Date:** 2026-08-21 · **Deciders:** Product, Engineering

## Context

The Task terminal rendered the whole transcript as one pre-wrapped string. Agents do not write
plain text: they write headings, lists, fenced code, tables and inline code, and a reviewer
reading a run to decide whether to approve it was reading raw markup — the exact place where
legibility matters most, because it is the human review gate Principle I depends on.

The constraint that shapes the choice is that **agent output is untrusted input rendered in the
operator's browser**. A transcript can contain anything an agent read from a repository, a web
page, or an issue body. Whatever renders it must fail safe by default rather than by
configuration, because the failure mode is script execution in an authenticated session.

Two smaller constraints follow from the surface itself. The terminal streams, so a renderer that
only accepts complete documents would re-parse a growing string on every chunk. And the app has
no `prose` typography layer: `globals.css` deliberately redefines the type scale down for a
console, and `@tailwindcss/typography` would fight it.

## Decision

Render assistant and operator text with **`react-markdown`** plus **`remark-gfm`**, through a
single `<AgentMarkdown>` component with an explicit `components` map onto the repo's own tokens.

**`rehype-raw` is not installed and must not be.** `react-markdown` escapes raw HTML by default;
that default is the security property being bought, and `rehype-raw` exists to remove it. The
component also refuses any link scheme other than `http(s)`, rendering it as plain text rather
than as an anchor, and does not load markdown images.

Markdown applies to the model's prose and the operator's own steering only. `notice` lines are
machinery talking about itself — a stray backtick in a mode switch would eat the line — so they
stay verbatim.

## Considered options

- **A minimal in-repo markdown renderer** — Rejected: no new dependency, but it moves the
  escaping rules into code we maintain, and escaping edge cases are precisely where a
  hand-written renderer is wrong. The dependency's value here *is* its default-deny behaviour.
- **`marked` (or similar) plus a sanitiser** — Rejected: produces an HTML string, which can only
  be mounted through `dangerouslySetInnerHTML`. The repo has zero uses of that today, and the
  safety of the result would depend on a sanitiser being configured correctly rather than on a
  library that never emits HTML in the first place. A string pipeline also cannot be memoized
  per block, which the streaming case needs.
- **`react-markdown` + `remark-gfm` (chosen)** — escapes HTML by default, returns a React tree
  (so settled blocks memoize and only the live tail re-renders), MIT-licensed and compatible
  with this repository's AGPL-3.0-only, and clean under `bun run audit`.

## Consequences

- Positive: a reviewer reads formatted output, including code and tables, in the surface where
  the approve/reject decision is made.
- Positive: the safe behaviour is the default. Turning it off would take a deliberate act
  (installing `rehype-raw`), not an oversight.
- Negative: a runtime dependency in `apps/web`, with the supply-chain surface that implies.
- Negative: markdown cannot be parsed on a fragment — a half-arrived fence would swallow the rest
  of the transcript — so the still-streaming tail of a turn renders as plain text and switches to
  markdown when the turn closes. `buildTranscript` is what marks that boundary.
- The XSS guarantees are load-bearing and therefore tested, not assumed: `markdown.test.tsx`
  asserts that raw HTML renders as text and that a `javascript:` link is not an anchor.
