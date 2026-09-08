---
name: SoloW
description: A dark control room for running AI coding harnesses in parallel under human review.
colors:
  background: "oklch(0.145 0 0)"
  foreground: "oklch(0.985 0 0)"
  surface: "oklch(0.205 0 0)"
  surface-raised: "oklch(0.269 0 0)"
  surface-hover: "oklch(0.371 0 0)"
  primary: "oklch(0.922 0 0)"
  primary-foreground: "oklch(0.205 0 0)"
  muted-foreground: "oklch(0.708 0 0)"
  border: "oklch(1 0 0 / 10%)"
  input: "oklch(1 0 0 / 15%)"
  ring: "oklch(0.556 0 0)"
  destructive: "oklch(0.704 0.191 22.216)"
  state-backlog: "oklch(0.68 0 0)"
  state-ready: "oklch(0.72 0.13 275)"
  state-running: "oklch(0.75 0.13 240)"
  state-review: "oklch(0.78 0.15 70)"
  state-parked: "oklch(0.72 0.12 320)"
  state-failed: "oklch(0.7 0.18 25)"
  state-done: "oklch(0.75 0.15 150)"
  diff-added: "oklch(0.72 0.17 145)"
  diff-removed: "oklch(0.72 0.19 25)"
  scm-open: "oklch(0.68 0.13 145)"
  scm-closed: "oklch(0.65 0.16 300)"
typography:
  headline:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.625rem"
    letterSpacing: "normal"
  title:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    letterSpacing: "normal"
  body:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.375rem"
    letterSpacing: "normal"
    fontFeature: "cv11, ss01"
  control:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  label:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "0.14em"
  code:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.05rem"
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  full: "999px"
spacing:
  unit: "4px"
  tight: "8px"
  panel: "12px"
  card: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "oklch(0.922 0 0 / 90%)"
    textColor: "{colors.primary-foreground}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.foreground}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input-text:
    backgroundColor: "oklch(0.145 0 0 / 40%)"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    height: "32px"
  badge-state:
    textColor: "{colors.state-review}"
    typography: "{typography.code}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  card-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "24px"
---

# Design System: SoloW

## Overview

**Creative North Star: "The Control Room"**

SoloW is an instrument panel for work that runs without you watching it. Its chrome is
deliberately colourless: every surface, border, and control token in the theme sits at chroma
zero, pure greyscale, because the interface's entire job is to make one thing findable at a
glance across seven columns of parallel work. That thing is state. Colour is therefore spent
almost nowhere and hoarded for three narrow signal families, of which the seven Task lifecycle
hues are the loudest. A reader who looks up from their editor should be able to tell, from the
corner of their eye and without reading a word, whether anything is waiting on them.

The register is precise, quiet, and mechanical, and it is dense the way professional tooling is
dense. Type is pitched down a full step from document sizes, controls sit on a four-pixel ladder,
numbers are tabular so a count changing in place does not shift its neighbours, and every button
depresses by exactly one pixel when pressed. Nothing here is hurried. The spinners run at two
different speeds depending on how many might be on screen at once, and the thinking indicator is
slower than either, because an operator watches it for minutes at a time and a brisk rhythm at
that duration reads as agitation rather than work.

Depth is made with light rather than shadow. A dark panel with no lit edge reads as a hole cut in
the page, so surfaces carry a one-pixel inset highlight along the top; shadows exist but are
ambient support, not the mechanism. A fine film grain sits over the whole viewport at under three
percent, which is enough to stop wide dark fields banding into plastic and to give the surface a
material quality without ever becoming a texture anyone notices. The shell is a VS Code shape,
five fixed regions, and that is a promise about how the product is used: open all day, beside
something else, never the only window.

**Key Characteristics:**
- Chroma-zero chrome; hue reserved for state, diff, and provider signals
- Dark-first, shipped dark-only, with a complete light token set held in reserve
- Console density: 13px control text, 24px status bar, 44px header
- Depth by lit edge, not by shadow
- Every state carries a hue, a glyph, and a word, never colour alone
- Motion is decoration everywhere except the two indicators where it is the information

## Colors

A greyscale instrument case with three separate families of signal light bolted onto it. The
shipped theme is dark. A complete light counterpart is defined on `:root` in `globals.css` but is
currently unreachable, because the document element is hardcoded to the dark class; treat it as
maintained-but-dormant rather than as dead code.

### Primary

- **Instrument White** (`oklch(0.922 0 0)`): the one filled emphasis in the system. It backs the
  primary button, the focused syntax keyword, and the workflow canvas's connection line. Because
  it is near-white on a near-black field, a single primary button is the loudest object on any
  screen, which is why there is rarely more than one.

### Secondary

The lifecycle family. These seven are the only place the interface allows itself hue at any real
saturation, and they are the same seven everywhere a Task appears: the board columns, the state
badges, the navigator's distribution bar, the workflow step strip, and the tool-call pills.

- **Dormant Grey** (`oklch(0.68 0 0)`): Backlog. Nothing has happened to it yet, so it gets no
  hue at all. Its greyness is a statement, not an absence.
- **Queued Indigo** (`oklch(0.72 0.13 275)`): Ready. Queued and about to move.
- **Working Blue** (`oklch(0.75 0.13 240)`): Running. A harness is working right now.
- **Waiting Amber** (`oklch(0.78 0.15 70)`): Review. The only state waiting on a person, and the
  warmest hue in the family for exactly that reason. Finding these is the point of the board.
- **Paused Violet** (`oklch(0.72 0.12 320)`): Parked. Paused on quota; it resumes by itself.
- **Failed Red** (`oklch(0.7 0.18 25)`): Failed. It will not resume by itself.
- **Done Green** (`oklch(0.75 0.15 150)`): Done. Reviewed, accepted, landed.

### Tertiary

Two small families kept deliberately apart from the lifecycle, because they describe unrelated
facts that would silently recouple if they ever shared a token again.

- **Diff Green / Diff Red** (`oklch(0.72 0.17 145)` / `oklch(0.72 0.19 25)`): added and removed
  lines in the review diff. Green-and-red is the one convention every git tool shares, and the
  diff is specified to behave like VS Code.
- **Provider Green / Provider Purple** (`oklch(0.68 0.13 145)` / `oklch(0.65 0.16 300)`): open and
  closed or merged issues and change requests, in GitHub's own dark-dimmed values. These colour
  four glyphs and nothing else; the chrome around them stays neutral.

### Neutral

- **Field Black** (`oklch(0.145 0 0)`): the page. Everything sits on it.
- **Panel** (`oklch(0.205 0 0)`): cards, popovers, and all three sidebars. One step up from the
  field is the entire elevation ladder for a resting surface.
- **Raised** (`oklch(0.269 0 0)`): secondary buttons and muted fills.
- **Hover** (`oklch(0.371 0 0)`): the accent surface, reached only by pointer or focus.
- **Ink** (`oklch(0.985 0 0)`) and **Half Ink** (`oklch(0.708 0 0)`): primary and secondary text.
- **Hairline** (`oklch(1 0 0 / 10%)`): every border in the app, as a translucent white so it
  tracks whatever it sits on rather than fixing to one surface value.
- **Alarm Red** (`oklch(0.704 0.191 22.216)`): destructive actions only. It is the single hued
  token in the chrome, kept because an irreversible action is a different kind of signal from a
  Task's lifecycle.

### Named Rules

**The Chroma-Zero Chrome Rule.** Every surface, text, border, and control token is chroma 0.
A blue-violet cast was removed from this theme by explicit decision. Do not reintroduce hue into
the chrome to suggest elevation, grouping, or brand; elevation is made with lightness and light.

**The Three Families Rule.** Task lifecycle, diff, and provider state are three separate colour
families. They may look similar (two greens, two reds) and they must never share a token. They
answer unrelated questions, and one of them changing must not drag the others with it.

**The Never Colour Alone Rule.** No state is ever communicated by hue alone. Every one carries
its own icon and an accessible word as well (WCAG 1.4.1). If a new state cannot be given a
distinct glyph, it is not ready to ship.

## Typography

**Display Font:** none. This system has no display type, by design.
**Body Font:** Geist Sans (with `ui-sans-serif, system-ui, sans-serif`)
**Label/Mono Font:** Geist Mono (with `ui-monospace, SFMono-Regular, monospace`)

**Character:** One neutral grotesque doing all the talking, with its monospace sibling for
anything read character by character. The pairing is unremarkable on purpose. Both faces are
self-hosted through `next/font`, so there is no render-blocking request and no layout shift, and
the monospace is not decorative: branch names, task identifiers, counts, and harness output are
scanned glyph by glyph, and leaving that to whatever the operating system supplies means the
terminal looks different on every machine. The body sets `cv11` and `ss01` with optical sizing on,
which is where a face earns its keep at eleven to thirteen pixels.

### Hierarchy

- **Headline** (600, 1.125rem/1.625rem): the largest type in the product. Page titles and empty
  states. There is nothing above it.
- **Title** (600, 1rem/1.5rem): section and card titles.
- **Body** (400, 0.875rem/1.375rem): prose, descriptions, transcript text. The default reading
  size.
- **Control** (500, 0.8125rem/1.25rem): the interface's true workhorse. Buttons, inputs, selects,
  nav rows, breadcrumbs. Thirteen pixels, not fourteen.
- **Label** (500, 0.6875rem/1rem, 0.14em tracking, uppercase): sidebar section headers, panel
  captions, column names. Small, spaced, and quiet.
- **Code** (400, 0.75rem/1.05rem, Geist Mono): identifiers, branches, counts, diffs, harness
  output.

### Named Rules

**The Thirteen-Pixel Rule.** The `sm` step is 13px, not Tailwind's default 14. Fourteen is a
document size; this is read in a panel beside an editor. The named steps are redefined at the
theme so vendored components inherit the pitch for free, and there is exactly one place to
change it. Never reach for an arbitrary bracket size to get back to a document scale.

**The Tabular Rule.** Any number that can change in place is `tabular-nums`: column counts,
durations, token totals, step indices. A count that reflows its neighbours when it ticks from 9
to 10 is a bug, not a detail.

**The No Display Type Rule.** Nothing in the app is larger than 1.125rem. A hero-sized heading in
an operating surface is a marketing gesture that has wandered in from a landing page.

## Layout

A five-region VS Code shell, fixed to the viewport at `100dvh` with exactly one scrolling area.
Left to right: a 48px icon rail (the activity bar), a 240px contextual sidebar (the navigator), the
main column, and a 288px inspector (the secondary sidebar). The main column carries a 44px header
holding a real breadcrumb trail, and a 24px status bar runs across the full width at the bottom.
The navigator appears at `md` (768px) and the inspector at `lg` (1024px); below those they are
simply absent, not collapsed into drawers.

The scrolling region is the `main` element and it is a positioning context, deliberately. Without
that, absolutely positioned descendants resolve against the initial containing block, escape the
region, stretch the document past the viewport, and produce a second page-level scrollbar beside
the first. This has happened; it is not hypothetical.

Everything sits on a four-pixel grid. Controls occupy a four-step ladder: 24, 28, 32, and 36
pixels tall, with 32 as the default, and inputs, selects, and the command bar all use the same
numbers so a field and the button beside it share a baseline exactly. Panel padding is 12px,
card padding is 24px, and the gap between related controls is 6 to 8px.

Board columns each own their full height and scroll independently. Scrollbars are thin, 9px, and
drawn as a low-contrast mix of the foreground, because this app has a great many scrolling panes
and none of them should announce themselves.

### Named Rules

**The Four-Pixel Ladder Rule.** Controls are 24 / 28 / 32 / 36. A new control that needs a height
picks one of those four; it does not invent a fifth. This is what makes a row of mixed controls
sit on one line without optical correction.

**The One Scroll Region Rule.** The app scrolls in exactly one place. A surface that introduces a
second page-level scrollbar has a positioning bug, not a layout preference.

## Elevation & Depth

Depth here is made by light, not by shadow. Every raised surface carries a one-pixel inset
highlight along its top edge (`inset 0 1px 0 0` at 5% white in dark), and that hairline is the
primary mechanism: without it a dark panel reads as a hole cut in the page rather than an object
sitting on it. Filled controls use the same trick at greater strength (18% white) so a primary
button reads as raised rather than as a painted rectangle. Shadows exist and are secondary; they
are ambient, describing the air around a floating thing, and they are never asked to do the work
of separating a panel from its background. Beneath all of it, a fixed film grain at 2.8% opacity
covers the viewport on one composited layer, breaking up the banding that flat dark fields
produce across wide gradients.

### Shadow Vocabulary

- **Panel** (`0 1px 2px oklch(0 0 0 / 40%), 0 8px 24px oklch(0 0 0 / 22%)`): a surface that has
  been lifted off the field but still belongs to the layout. Cards and docked panels.
- **Float** (`0 2px 6px oklch(0 0 0 / 45%), 0 24px 64px oklch(0 0 0 / 40%)`): something genuinely
  detached and temporary. Dialogs, popovers, the command palette, a dragged card.
- **Lit edge** (`inset 0 1px 0 0 var(--edge-highlight)`): not a shadow at all, and the one that
  matters most. Applied via the `surface-edge` class.

### Named Rules

**The Hairline Rule.** A dark panel gets a lit top edge or it reads as a hole. Reach for the
highlight before reaching for a shadow, always.

**The Two Shadows Rule.** There are two elevations, panel and float, and no others. If a surface
seems to need a third, it is either a panel or a float and the question is which.

## Shapes

Rounded, moderately, on a scale derived from one root value of 10px: 6px for small chips and
inner elements, 8px for controls, 10px for panels, 14px for cards, and a full pill for anything
that carries a state or a count. Nothing in the system is square-cornered and nothing is
dramatically round; the corner radius is not where this design expresses itself.

Borders are hairlines at 10% white and they are everywhere, because on a dark field a one-pixel
edge separates two surfaces far more cheaply than a lightness step does. The focus outline follows
the element's own radius, so a pill stays a pill when focused; an earlier version set its own
radius and squared them off.

Icons are Lucide, at 14px inside controls, 17px in the activity rail, and 12px inside badges,
with stroke weights of 2 to 2.25. The brand mark is a control barrier with its arm raised, drawn
as one post, one lifted arm, and a pivot dot. The obvious gate, two uprights and a crossbar, was
rejected because at 16px it reads as the letter H, and the corner of a rail is the only place the
mark ever appears.

## Components

### Buttons

- **Shape:** softly rounded (8px), never pill, never square.
- **Sizes:** the four-step ladder, 24 / 28 / 32 / 36, default 32.
- **Primary:** near-white fill on the dark field with dark text, plus an 18% white inset top
  highlight so it reads as raised. Padding 0 12px at default size.
- **Hover / Active:** background shifts to 90% opacity on hover, 95% on press, over 100ms
  ease-out. Every variant depresses by exactly one pixel (`translate-y-px`), which is a transform,
  so it composites.
- **Outline / Secondary / Ghost:** transparent or raised-grey fills that resolve to the hover
  surface. Outline additionally warms its border toward the ring colour on hover.
- **Disabled:** reads as switched off rather than merely faded. Pointer events off, opacity 45%,
  and the press is suppressed.
- **Loading:** built into the component rather than left to call sites. It swaps the leading icon
  for a spinner and blocks the control, so a pending action can never be clicked twice. In this
  product that means a second review decision on the same session, which is why it is not
  optional.

### Badges

- **Style:** soft, never filled. One definition serves the whole app: the colour at full strength
  for the text, the same colour mixed into the surface at 8% for the fill and 10% for the border.
- **Critical detail:** the mix is into the background, not into transparent. A translucent badge
  takes on whatever is behind it, so the same label reads one colour on a row and another on that
  row hovered, and appears to change meaning when nothing changed.
- **Shape:** full pill, 12px text, 2px by 8px padding, 12px icon.

### Cards / Containers

- **Corner Style:** 14px.
- **Background:** the panel grey, one step above the field.
- **Shadow Strategy:** the panel elevation, plus the lit top edge. See Elevation & Depth.
- **Border:** hairline, always.
- **Internal Padding:** 24px, with a 24px gap between stacked sections.

### Inputs / Fields

- **Style:** 32px tall to match the default button, 8px radius, hairline border, and a background
  at 40% of the field colour so a field reads as recessed rather than as another panel.
- **Focus:** the app-wide outline only, plus a border that warms toward the ring. There is no
  second ring; the vendored components shipped one and it drew a duplicate around every control.
- **Error / Disabled:** invalid state colours the border with the destructive token. Disabled
  drops to 45% and refuses the pointer.

### Navigation

- **Activity bar:** a 48px icon rail. The active marker is a bar along the rail's edge, not a
  filled pill, because the whole job of a rail you are not looking at is to read from the
  periphery. Icons at 17px, stroke 2.
- **Navigator:** 240px, panel background, with uppercase 11px section headers at 0.14em tracking
  and 14px rows. Counts sit right-aligned in the monospace face.
- **Breadcrumb:** a real trail, not a label. Every segment but the last is a link, and the shape
  states the hierarchy in words: Workspace, then Project, then Section, then leaf.
- **Status bar:** 24px, 11px text, muted throughout, with numbers right-aligned and tabular.

### Task State Badge (signature)

The most important component in the product, and the reason the colour system exists. One
component rather than a variant chosen at each call site, because the mapping from state to
appearance is domain knowledge rather than styling: it decides whether a reader can tell "a
harness is working" from "a harness is waiting for me" at a glance. It renders the state's hue as
a soft badge, its own glyph, and its label, and in the two live states the glyph turns at the
ambient two-second cadence rather than the brisk one, because a board may have a dozen of them
running at once and a dozen brisk spinners read as alarm.

### Board Column Header (signature)

Each column's head is washed in its own state colour at 10% with a two-pixel rule of that colour
at full strength across the top, so a column is identifiable from across the room. An empty column
drops to 70% opacity and mutes its label, so it recedes without disappearing. The column header
knows nothing about lifecycle states specifically; it takes a descriptor, which is what lets a
Workflow Step render with the same markup a state does.

### Motion

Motion is decoration in this system, never information, with exactly two exceptions. Controls
transition over 100ms ease-out; navigation colours over 150ms; a card entering a column fades and
slides one step over 200ms; workflow nodes re-laid out slide over 280ms on a
`cubic-bezier(0.2, 0.8, 0.2, 1)`, so after a delete the eye follows each card instead of reading
the row's new shape as a loss.

Spinners run linear, deliberately: any easing makes a spinner look like it is labouring,
accelerating and stalling once per turn. There are two cadences, 1.1s for a single control someone
is waiting on and 2s ambient for a board where many turn at once. The thinking indicator is
slower still at 1.4s, three dots staggered by 0.18s and travelling two pixels, borrowing the
typing indicator every reader already knows, because it sits under a transcript for as long as a
model is composing.

### Named Rules

**The One Ring Rule.** There is exactly one focus treatment in the app, a 2px outline at 2px
offset on `:focus-visible` only, so a mouse user never sees it. Components do not bring their own.

**The Soft Badge Rule.** Badges mix their colour into the surface, never into transparent. One
definition, in the components layer, serves every badge in the product.

**The Indicating Motion Exception.** Reduced motion switches everything off except the spinner and
the thinking dots, whose movement is the only thing separating "still working" from "hung". Those
keep indicating by brightness instead: no transform, nothing that travels. Reduced motion asks for
less movement, not for less meaning.

## Do's and Don'ts

### Do:

- **Do** keep chrome at chroma 0 and spend hue only on the three signal families. The greyscale is
  a decision the codebase already made once, on the record.
- **Do** give every new state a glyph and an accessible word alongside its hue. Colour alone fails
  a colour-blind reader, and these distinctions are the product.
- **Do** pick control heights from the ladder: 24, 28, 32, or 36. Default to 32.
- **Do** reach for the lit top edge before a shadow when a surface needs to sit forward.
- **Do** use `tabular-nums` on any number that changes in place.
- **Do** route new badges through the soft-badge definition rather than writing a filled pill.
- **Do** let the component own its loading state, so a pending action cannot be double-clicked.
- **Do** target WCAG 2.2 AA, the standard recorded in PRODUCT.md, including the keyboard drag
  path on the board and the reduced-motion behaviour above.

### Don't:

- **Don't** import a vendor theme or third-party palette. The syntax highlighting is written in
  this app's own tokens precisely so a GitHub-blue keyword never sits beside this product's
  indigo and makes the transcript read as two products stapled together.
- **Don't** bring marketing-page gestures into operating surfaces: no hero sections, no display
  type above 1.125rem, no decorative gradients. The two faint radial washes behind the sign-in
  card are the single deliberate exception, and they exist because that screen is a lone card on
  an otherwise empty field.
- **Don't** let the lifecycle, diff, and provider colour families share a token, however similar
  two of them look.
- **Don't** add a second focus ring, a second scroll region, or a second definition of "soft".
- **Don't** ease a spinner. Linear is the considered choice here, not the lazy one.
- **Don't** speed up the thinking indicator. Its unhurried rhythm is what separates a model
  composing from a stalled network request, watched over minutes.
- **Don't** repeat a Task's lifecycle state as a badge on a card that already sits in the column
  for that state. The column says it; a pill on every card is seven columns of noise. Review is
  the one exception, and it earns it by being the only state waiting on a person.
