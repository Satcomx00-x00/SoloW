---
target: the board
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/debian/GateControl/apps/web/src/components/features/board/board.tsx"
target_fingerprint: "sha256:37e85dca74e91776f7e515df7797f2962b9283071fb759ae6c2a9efbdfd20d01"
target_path: /home/debian/GateControl/apps/web/src/components/features/board/board.tsx
timestamp: 2026-09-07T18-32-33Z
slug: src-components-features-board-board-tsx
---
Method: dual-agent (A: design review, source-only; B: detector + browser evidence)

# Design Critique: the Kanban Board

Target: `src/components/features/board/board.tsx` and the board surface around it. Mode: Operate.

Evidence caveat: neither agent saw this board rendered. Browser tooling failed for both, and by the
time Assessment B ran, the app on port 5000 was down. Every finding is read from source and verified
against it. The `chrome-devtools-local` tool variant works where the default one times out, so a
future run can get real screenshots if the app is up.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live WebSocket updates and a shape-matched skeleton are strong. A Running card shows no elapsed time, so a 20-second run and a 3-hour wedge look identical. |
| 2 | Match System / Real World | 3 | Copy is glossary-exact throughout. The final failure-reason fallback prints a raw machine string to a user who cannot act on it. |
| 3 | User Control and Freedom | 3 | The confirm dialog for dragging out of Review is exemplary. No undo on a committed move; the drag-error banner has no dismiss. |
| 4 | Consistency and Standards | 3 | Internally very consistent, and the detector agrees: zero findings. The break is in the navigator beside it, where seven rows look like the filters next door but are inert. |
| 5 | Error Prevention | 3 | Namespaced column ids, no drop target on gated steps, disabled launch with a reason. Undercut by one shared busy flag. |
| 6 | Recognition Rather Than Recall | 2 | The drag handle is fully transparent at rest, so the board's signature gesture is invisible. Two failure explanations live only in `title` attributes. |
| 7 | Flexibility and Efficiency | 2 | No board search, no filter, no multi-select, no bulk launch, on a surface whose premise is running many things at once. |
| 8 | Aesthetic and Minimalist Design | 3 | The no-repeated-state rule is honoured and empty columns recede beautifully. A card can still stack five chips inside a 272px column. |
| 9 | Error Recovery | 3 | Named reasons with one-click fixes are best in class. The unmapped fallback and the sticky banner pull it down. |
| 10 | Help and Documentation | 2 | The disabled-flag message printing the exact enabling command is excellent. Otherwise no state legend, no keyboard-drag hint, help is hover-only. |
| **Total** | | **27/40** | **Acceptable, upper edge** |

## Design Specificity Verdict

Authored for this product, but the authorship stops at the card's edge.

Design review: specificity is unusually deep in the taxonomy layer and near-absent in the time and
cost layer, which is where a parallel-harness product actually lives. No generic kanban tool could
ship: a drag refusal that explains the review gate; a named failure vocabulary where an expired
credential offers Renew and a partly-integrated run deliberately withholds Retry because half the
repositories landed; gate chrome that colours only human gates; step columns that register no drop
target at all, so a gesture cannot bypass an approval.

Against that, a card carries no time and no cost. Both timestamps are already on the DTO and neither
is rendered. The Running column header shows a bare count where the product's differentiator is a
concurrency cap, so it says `3` and never `3 / 4`. Parked says it resumes automatically and never
says when. Nothing on any card names the billing mode. The board is excellent at answering what kind
of thing this is, and generic at answering how long, how much, and how close to the cap.

Deterministic scan: the board is CLEAN. 18 source files, zero findings, exit 0. Verified genuine with
an in-tree control file that produced the expected findings, proving detector, DESIGN.md loader and
sidecar are all live. No ignore rules or inline suppressions exist. Four advisory findings sit just
outside the target, all one rule (font size below the documented ramp): a 7px badge and a 9px badge
in the shell, two 10px keycaps in the command palette. The smallest DESIGN.md step is 11px, so these
are real off-ramp values, not false positives. Advisory only; no effect on exit status.

False positives: none.

Visual overlays: none. Injection never attempted because there was no running page. Mutable injection
was verified to work, so the only blocker was the dead target.

## Overall Impression

A genuinely well-built surface whose engineering reasoning is visible in every file, held back by one
architectural reflex and one missing dimension. The reflex is a single shared busy flag that
serializes a board built for parallelism. The missing dimension is time. Everything else is polish by
comparison. Biggest opportunity: put duration and capacity on the board.

## What's Working

1. The state system is a type, not a policy. Icon, hue, word and hint live in one record consumed by
   the badge, the column head, the navigator bar and the step chrome. A state without a glyph will
   not compile. Never Colour Alone is enforced by the compiler rather than by discipline.
2. Refusals are authored, not surfaced. No wire code reaches a human anywhere on this board. Disabling
   launch and explaining why in a tooltip teaches the rule rather than reporting a failure.
3. Drag announcements are hand-written for screen readers, overriding the library defaults so a
   screen reader hears "Keypad is over Ready" rather than a raw state id.

## Priority Issues

[P1] One shared busy flag serializes a board built for parallelism. `board.tsx:326` computes `busy`
from three pending mutations and passes it to `disabled` on every card control at lines 373, 420, 436
and 476. Launching one task greys out Launch on every other card. Verified directly. The per-card
pending helper already exists but is used only for the spinner.
Why: the exact opposite of the product's premise. Fix: delete `busy`, use the per-card pending check
for both `disabled` and `loading`; the mutations are already independent server-side.
Command: /impeccable harden

[P1] No elapsed time on a live card. Both timestamps are on the DTO; the card reads one only to
compute a boolean and renders neither.
Why: an operator cannot distinguish a healthy run from a hung one without opening it and reading
logs, which the product's own usability bar forbids. Fix: tabular relative duration in the card meta
row for running/review/parked, on the existing socket tick; add a denominator to the Running column
header so the concurrency cap is visible before a task parks.
Command: /impeccable layout

[P1] Three board controls fail WCAG 2.2 AA target size (2.5.8, 24x24 CSS px). The drag handle
computes to 22x22 (verified from padding + icon size). The blocked-by lock button is ~18px tall, the
issue menu trigger ~20px. All three sit within 6px of a neighbouring target, so the spacing exception
does not rescue them.
Why: AA is the standard recorded in PRODUCT.md, and the drag handle is the board's primary gesture.
Fix: pad all three to the 24px rung of the existing four-pixel ladder.
Command: /impeccable audit

[P2] The board is a dead end for creating work. The route comment says create actions live in the
shell header, but nothing renders into the header outlet from any board route, and the global create
menu was deliberately removed. The empty state is prose with no button.
Why: PRODUCT.md states the job as breaking an issue into tasks on a board. Fix: mount the existing
create-task dialog in the Backlog column head, give the empty state a button, delete the stale comment.
Command: /impeccable onboard

[P2] Load-bearing explanations live in `title` attributes. Two failure reasons put their entire
meaning into hover-only text that is mouse-only and inconsistently announced. The tooltip primitive is
already imported in the same file. Fix: move both to the real tooltip.
Command: /impeccable clarify

## Persona Red Flags

Alex (impatient power user): sixty tasks means scrolling seven independently scrolling columns with no
search and no filter. Launching six ready tasks is six round trips, serialized by the busy flag. The
drag grip is invisible until hover, so his first instinct is to grab the card body, which is a link,
landing him on a detail page he did not want.

Sam (screen reader / keyboard only): every card puts an invisible move button in the tab order, so a
forty-card board is ~120 tab stops with no skip link. The three target-size failures are his. The
title-only explanations are invisible to him. The launch refusal reaches him through a tooltip on a
wrapper around a disabled button, a pattern that frequently is not announced at all.

Mara (solo operator, four harnesses deep; from PRODUCT.md's primary user): runs on one subscription
with a concurrency cap and glances at the board between edits. The board never shows how close she is
to the cap, so parked cards arrive as a surprise the design promised would never be surprising. She
cannot tell which running task has been going longest. When two land in review at once, nothing orders
them and nothing previews what is inside either.

## Minor Observations

- The 11px label step is used for repository names, branch names and failure text, which is content
  rather than labels. The documented floor for read content is 12px.
- The skeleton hardcodes a distribution over the first five states, so Failed and Done never appear in
  the placeholder and the layout still shifts on arrival.
- The drag-error banner is inserted above the board with a top margin, pushing all seven columns down
  at the exact moment attention is on the card that just snapped back.
- The drag overlay is hardcoded to 268px against 288px columns.
- Blocked-by renders on parked, failed and running cards, where declaring a new predecessor is
  meaningless.
- Several muted text values land near 3.2:1 to 3.5:1 against their surface, below the 4.5:1 AA
  threshold.
- Cognitive load: three checklist failures, moderate. Seven columns exceeds the working-memory ceiling
  of four; a failed card renders four controls; the blocked-by dialog lists every other task in the
  workspace, unbounded and ungrouped.

## Questions to Consider

1. If the board's job is finding what is waiting on you, why is Review the fourth of seven equally
   weighted columns rather than pinned, widened, or first?
2. The differentiator is a concurrency cap and a Parked state. Why does no column head render a
   denominator?
3. The harness's own account of what it did is spent as a hover tooltip. If the human decision is the
   product, why is the only preview of that decision mouse-only?
4. Would five columns, with Parked and Failed as badges inside Running, answer the operator's question
   faster than the lifecycle enum drawn literally?
5. If the shared busy flag is deliberate, what failure was it protecting against, and is the board
   still worth calling parallel?
