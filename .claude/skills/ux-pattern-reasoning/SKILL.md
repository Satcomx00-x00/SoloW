---
name: ux-pattern-reasoning
description: >
  Senior-designer reasoning for UI work — decide and justify interaction, motion, form, feedback,
  visual, navigation and content patterns with concrete values (durations, easing, contrast ratios,
  spacing scales, z-index layers) instead of guessing. Sourced from the designmotionhq pattern
  library (76 patterns across 7 categories).
  Use this skill WHENEVER building or reviewing UI, even when the user never says "design" — a
  modal, dropdown, toast, loading state, form validation, empty state, data table, hover effect,
  dark mode, animation, or landing section all qualify. Trigger on symptom complaints too
  ("this feels cheap", "looks AI-generated", "the animation is janky", "my dropdown is broken",
  "why does this feel slow", "make it look premium", "the validation fires too early"), on
  accessibility questions (focus, contrast, reduced motion, touch targets), and on any request to
  polish, refine, or productionize a component. Default to consulting it before writing component
  code — the cost of reading a reference is far lower than shipping a pattern that has a known
  correct answer.
sources: [https://www.designmotionhq.com/patterns]
aliases: [ui-patterns, design-patterns, ux-reasoning, designmotionhq]
---

# UX Pattern Reasoning

76 patterns from designmotionhq, distilled into senior-designer rules with concrete values.

## Pattern Index by Category

| Category | Count | When to reach for it |
|---|---|---|
| **interaction** | 23 | clicks, hovers, drag, keyboard, gestures, modals, menus |
| **visual** | 20 | layout, color, shadow, depth, tokens, hierarchy, charts |
| **forms** | 12 | inputs, validation, pickers, OTP, toggles, autosave |
| **feedback** | 9 | loading, skeletons, toasts, error states, optimistic UI |
| **motion** | 4 | animation timing, easing curves, card hover, scroll |
| **navigation** | 4 | tabs, nav patterns, pagination, focus states |
| **content** | 4 | empty states, microcopy, serial position, landing skeleton |

## Reference Files

Read the relevant file **before** answering. Pick all that apply.

- `references/interaction.md` — accordion, bulk actions, command palette, context menu, CSS :has(), data table, destructive actions, disabled buttons, drag-and-drop, dropdown, filter chips, hover trap, inline editing, live cursors, modal hierarchy, peak-end rule, search system, star rating, swipe actions, bottom sheets, color picker, tooltip
- `references/visual.md` — border radius, charts, color accessibility, dark mode, depth layers, design system kit, design tokens, gestalt laws, golden ratio, gradient, grid system, icon rules, perfect card, proximity rule, reverse-engineered Linear, shadow elevation, visual hierarchy, von Restorff, z-index mastery, de-AI hero
- `references/forms.md` — autosave, date pickers, file upload, form field states, form validation timing, input masking, OTP input, password field, range sliders, settings system, stepper wizard, toggle anatomy
- `references/feedback.md` — doherty threshold, error states, loading states system, notification system, optimistic UI, skeleton loading, toast notifications, undo UX, zeigarnik effect
- `references/motion.md` — animation timing, card hover anatomy, easing curves, scroll-driven animations
- `references/navigation.md` — focus states, navigation patterns, pagination, tabs system
- `references/content.md` — empty states, landing page skeleton, microcopy, serial position

## Workflow

1. **Identify category** from the user's component or symptom.
2. **Read the relevant reference file(s)** — always read before answering.
3. **Apply the pattern**: give the concrete rule + concrete values (ms, px, ratio, CSS snippet).
4. **Flag the Do/Don't** for the specific mistake you see (or the anti-pattern to avoid).
5. **Cross-reference** if the component spans categories (e.g. a form with motion feedback).

## Output Format

For each pattern applied:
```
**Pattern: [Name]** (category)
Rule: <one concrete sentence>
Values: <exact ms / px / ratio / CSS>
Do: ...
Don't: ...
```

If reviewing existing code/design, lead with the symptom → root cause → fix pattern.
