---
name: refactoring-playbook
description: "How to change structure without changing behaviour: characterise first, move in small steps, verify after each."
---

# Refactoring playbook

A refactor changes the shape of the code and nothing the code does. Every rule below exists to
keep that sentence true.

## Before touching anything
- Run the existing tests and record what passes. A test that fails before you start is not yours
  to fix in this pass — note it and leave it.
- Where the code you will move has no tests, write **characterisation tests** first: they assert
  what the code does *today*, including behaviour that looks wrong. They are your safety net, not
  a statement of what the code should do.

## While refactoring
- One transformation at a time: extract, rename, move, inline, replace conditional with
  polymorphism. Run the tests between each. If a step turns red, undo that step rather than
  patching forward.
- Keep public signatures working. When a signature must change, add the new one, migrate callers,
  then delete the old one — three steps, each green.
- Do not fix bugs, add features, or "improve" behaviour on the way. Write those down for a later
  pass; a refactor that also changes behaviour cannot be reviewed as either.
- Match the surrounding code's naming, comment density, and idiom. A refactor that introduces a
  second style is a net loss.

## After
- The full suite passes; the characterisation tests still pass unmodified.
- The diff is explainable in one paragraph: what moved, why the new shape is better, what did not
  change. If that paragraph needs a "however", the pass was too big.
