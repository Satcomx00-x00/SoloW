# Navigation Patterns

## Focus States
> States Press Tab.

**Key insights:**
outline: none isn't a style choice — remove the default focus ring and you've shipped an accessibility failure. If you kill it, replace it with something better. A proper focus ring needs three things: 2px thickness, a 2px offset , and enough contrast to stay visible on both light and dark backgrounds. :focus-visible tells mouse and keyboard apart — a click gets no ring, a Tab press gets one — so keyboard users can navigate without cluttering the pointer experience. Focus follows the DOM order , not your visual layout. Reorder columns with CSS and Tab starts teleporting across the page — keep visual order and DOM order in sync. Inside a modal, trap the focus : Tab should cycle through the dialog and wrap around, and Escape should close it and hand focus back to the element that opened it. A skip link jumps past dozens of nav links in a single keypress. Keep it invisible until focused, and make it the first element on the page.

**Do / Don't:**
Do: Replace a removed outline with a custom ring — 2px thick, offset, and contrasting on every background Do: Reach for :focus-visible so keyboard users get a ring while mouse clicks stay clean Do: Place a skip link as the first focusable element, hidden until focused Don't: Set outline: none without shipping a visible replacement Don't: Reorder content with CSS and let the DOM order drift from the visual order Don't: Let a modal leak focus to the page behind it, or drop focus when it closes

---

## Navigation Patterns
> Five nav patterns, one system: mobile = tabs, desktop = sidebar.

**Key insights:**
Bottom tabs are the mobile default: 3-5 top destinations, always visible and within thumb reach. Burying those same links in a hamburger drops engagement ~40%. A persistent sidebar is the desktop answer for hierarchical content with 5+ sections — keep it in view, since collapsing it by default kills discoverability. The hamburger is secondary navigation, never primary. It's acceptable on mobile, but hiding the menu on desktop drops engagement ~56%. A command palette (Cmd K) is a search-driven accelerator for power users — pair it with visible nav, because new users don't know it exists. Breadcrumbs only earn their space when the hierarchy runs deeper than 2 levels; on flat structures they add noise instead of orientation. Choose by platform and depth , not taste — the whole set is one system, not five interchangeable options.

**Do / Don't:**
Do: Match the pattern to the platform: bottom tabs on mobile, a persistent sidebar on desktop. Do: Keep primary destinations visible — 3-5 for tabs, 5+ sections to justify a sidebar. Do: Reserve breadcrumbs for hierarchies deeper than two levels. Don't: Hide primary navigation in a hamburger — engagement drops 40-56%. Don't: Make a command palette the only path to a feature; new users won't discover it. Don't: Add breadcrumbs to a flat structure where they're just visual noise.

---

## Pagination
> Add one row and your pagination breaks.

**Key insights:**
Offset pagination drifts when the data changes — insert a row at the top and every page shifts down, so the same item can surface twice (or get skipped entirely). Cursor pagination stays stable: it anchors to a specific row instead of a numeric position, so inserts and deletes never create duplicates. Three patterns fit different jobs — numbered for jumping to any page, load-more for on-demand appends, infinite scroll for continuous feeds. Never render every page link. Truncate to first, last, current, and its immediate neighbors, using an ellipsis for the gaps. Keep the page number in the URL ( ?page=500 ) so a refresh stays put and the view becomes a shareable link. When users return from a detail view, restore their scroll position instead of dumping them back at the top of the list.

**Do / Don't:**
Do: Reach for cursor pagination when rows are inserted or deleted often, to avoid duplicates and skips Do: Persist the current page in the URL so refreshes and shared links land on the same page Do: Collapse long page ranges to first, last, current, and neighbors with an ellipsis Don't: Render hundreds of numbered links — they spill off-screen and overwhelm Don't: Reset an infinite-scroll list to the top when the user comes back from a detail view

---

## Tabs System
> Tabs aren't a widget.

**Key insights:**
The active indicator should slide, never teleport. Drive it with a spring and match its timing to the content fade — slow in, fast out . When tabs overflow one screen, never wrap to a second line . Scroll horizontally, add edge fades to hint at what's off-screen, and put chevron buttons on desktop. Make it keyboard-operable: arrows move between tabs, Home jumps to first, End to last, and Tab exits to the next focusable group. The focus ring and the active state must never share a color — otherwise keyboard users can't tell where they are versus what's selected. Content should never hard-cut on switch. Fade out, pause ~80ms, fade in , and match panel heights so nothing shifts. Mobile isn't a shrunk desktop: use a segmented control under 5 tabs , a bottom sheet over 5 , never a scaled-down bar.

**Do / Don't:**
Do: Slide the active indicator with a spring, timed to match the content fade Do: Scroll an overflowing tab row horizontally with edge fades and desktop chevrons Do: Give the focus ring and active state distinct colors Don't: Wrap an overflowing tab row onto a second line Don't: Hard-cut content on switch — fade out, pause, fade in instead Don't: Reuse the desktop tab bar shrunk down on mobile

---
