# Interaction Patterns

## Accordion Disclosure
> One accordion glides open, the other jumps.

**Key insights:**
You can't animate height: auto — the transition just snaps. Use display: grid with grid-template-rows going from 0fr to 1fr , or measure scrollHeight and animate to a pixel value. Drive the chevron rotation from the same timing curve as the panel . Even ~10 frames of lag between the two reads as broken, not smooth. Decide single vs multi open : an accordion lets one panel open at a time, a disclosure lets many stay open. Sequential steps stay single; FAQ lists let several breathe. The header is a <button> , not a <div> . Wire aria-expanded to reflect state and aria-controls to point at the panel, so Enter/Space toggle it and the focus ring shows. When an item near the bottom expands, anchor the tapped header so the list doesn't jump under the user, and stagger the revealed content in.

**Do / Don't:**
Do: Drive chevron rotation and panel height from one shared timing curve so they move as a unit Do: Render the header as a real <button> with aria-expanded and aria-controls wired to the panel Do: Match open behavior to content — one-at-a-time for steps, many-open for FAQ lists Don't: Animate height: auto and expect a transition — use grid rows or a measured pixel height Don't: Let the chevron trail the panel; even a few frames of lag feels janky Don't: Let the list scroll-jump when a lower item expands — keep the tapped header anchored

---

## Behind The Button
> Six things happen before the spinner stops.

**Key insights:**
Client-side validation exists for speed, not safety. Green checks and inline errors fire with 0 network calls because catching mistakes instantly is a frontend job. The server re-runs every check the client already did, only stricter. Never trust the client : anyone can forge a request, so re-compute the total from your own catalog instead of believing the price the browser sent. Wrap the related writes (order, items, inventory, payment) in one transaction . If a single row fails, every row rolls back, so an order never lands half-written. All of it, or none of it. When the response returns, repaint the UI with server truth , the real order ID the server created, not a value you guessed locally. Optimistic UI fits cheap, reversible actions: a like, a favorite, a rename can repaint instantly and reconcile in the background. Money is different, so hold the spinner until the server actually confirms.

**Do / Don't:**
Do: Validate on the client for speed and on the server for trust, never one instead of the other. Do: Re-compute prices and totals server-side from your own source of truth. Do: Wrap multi-row writes in one transaction so any failure rolls back the whole thing. Don't: Trust values the client sends, including the price, since a request is trivial to forge. Don't: Reach for optimistic UI on payments or other irreversible actions; make them earn the spinner.

---

## Bottom Sheets
> Your thumb can't reach that menu.

**Key insights:**
Screens keep getting taller while thumbs stay the same length, turning the top of the display into a dead zone for one-handed use. Anchor menus and actions to the bottom of the screen, where the thumb naturally rests, instead of the top-right corner most navs default to. Unlike a full modal that blocks everything, a bottom sheet keeps the underlying page visible so users never lose their place. Add snap points so the sheet can rest half-open or expand to full height, matching how much content the user actually needs. Support drag-to-dismiss — a downward gesture maps to the sheet's direction and needs no tiny close target to hit. Dim the background with a scrim and lock body scroll so only the sheet moves, keeping focus on the active task.

**Do / Don't:**
Do: Place primary actions within thumb reach at the bottom of the screen Do: Keep the page visible behind the sheet to preserve context Do: Offer snap points and drag-to-dismiss for flexible, gesture-friendly height Don't: Bury frequent menus in the top-right dead zone on tall phones Don't: Block the whole screen with a full modal when a sheet would do Don't: Leave the background scrollable while the sheet is open

---

## Bulk Actions
> Bulk actions are a system, not a lone checkbox.

**Key insights:**
The header checkbox needs three states : empty, partial, and checked. The indeterminate dash is not optional, and partial always resolves to select-all, never to clear. Name the number. When select-all only grabs the rows on screen, offer 'Select all 247 matching' instead of a bare 'all' that hides the true scope. Keep the count honest as context shifts. Change a filter and the label should re-read live (from 247 matching down to 96) so people act on the real set. Selection is state, not the DOM. Shift-click picks a range, and the selected ids survive paging because they live in application state, not in the visible rows. For destructive bulk actions, skip the confirm modal. Echo the count , run the action immediately, and offer a 10 second undo with a draining countdown ring.

**Do / Don't:**
Do: Give the header checkbox all three states and let the partial dash resolve to select-all. Do: Spell out the exact count in the affordance, like 'Select all 247 matching'. Do: Swap destructive confirm dialogs for an undo window that echoes what you deleted. Don't: Ship a two-state header checkbox that skips the indeterminate dash. Don't: Label bulk selection with a vague 'all' that hides how many rows you touched. Don't: Store the selection in the DOM, where it silently resets the moment someone changes page.

---

## Color Picker Ux
> Pick a color.

**Key insights:**
Treat the picker as a decision tool, not a gradient with a slider — every choice cascades into the rest of the UI. Offer OKLCH next to hex. Hex is for machines; OKLCH's lightness, chroma, and hue let you change one number and get a predictable shade. Give the picker memory : recent swatches and saved palettes put your last five picks one tap away instead of re-hunting each time. Show a live contrast ratio at pick time, not in review — a badge that flips red to green kills failing pairs before they ship. Preview alpha over a checkerboard on both light and dark backgrounds. Transparency lies on a white canvas, so check it before you commit. Turn one pick into a system: generate tints and shades from a single hue to produce ten tokens from one decision.

**Do / Don't:**
Do: Expose human-readable formats like OKLCH so one value maps to a predictable shade Do: Surface recent swatches and saved palettes so past picks stay one tap away Do: Validate contrast live while picking, with a badge that reads red or green Don't: Preview alpha only on white — a checkerboard reveals the true transparency Don't: Ship a bare gradient-and-slider picker with no memory, contrast check, or palette output

---

## Command Palette
> Palette ⌘K is a system, not a search box.

**Key insights:**
Use fuzzy matching , not exact substring search — typing "stg" should still surface "Settings", "Storage", and "Staging". Exact matching returns nothing and feels broken. Group results into labeled sections (Recent, Actions, Pages) so a long flat list becomes scannable structure instead of an undifferentiated wall. Make it fully keyboard-driven : arrows move the highlight, Enter runs the selected command, Esc closes — never force the user back to the mouse. Never open to a blank void. Prefill recent or suggested commands so people have a starting point before they type a single character. For async commands , show an inline spinner and keep the palette open — load results in place rather than freezing the whole screen. Support nested commands : one command can drill into a sub-menu with a breadcrumb, and Esc walks back exactly one level.

**Do / Don't:**
Do: Match queries as fuzzy subsequences so "stg" still finds "Settings" Do: Prefill recent and suggested commands so the palette opens with something to act on Do: Drive everything from the keyboard — arrows to move, Enter to run, Esc to go back Don't: Require exact substring matches — "stg" ≠ "Settings" leaves users staring at "No results" Don't: Open to a blank "No results" void with nothing to select Don't: Freeze the whole screen while an async command loads instead of spinning inline

---

## Context Menu
> A context menu is a system, not just a list of actions.

**Key insights:**
A context menu measures before it opens . No room below, it flips up; no room to the right, it mirrors left, always anchored to your cursor and always inside the viewport. Twelve flat actions read as noise. Group by intent and split with dividers: pair Rename with Duplicate, Share with Copy link, and isolate Delete at the bottom in red . Submenus die the instant the cursor drifts off the row. Draw an invisible safe triangle from cursor to submenu so the menu holds while you move diagonally toward it. That is hover intent. Power users never aim. Arrows walk the list, letters jump (press D, land on Duplicate), and Escape closes one level, not the whole menu. Mobile has no right click. A long press opens the same actions as a bottom sheet : one menu system, two triggers.

**Do / Don't:**
Do: Measure available space and flip the menu so it always opens inside the viewport. Do: Group actions by intent with dividers, and set the destructive action apart at the bottom in red. Do: Add a safe triangle from cursor to submenu so it survives a diagonal move. Don't: Close a submenu the moment the cursor leaves the row, ignoring the diagonal path toward it. Don't: Dump a dozen ungrouped actions into one flat, unscannable list. Don't: Ship right-click only; wire a long press to the same actions on mobile.

---

## Css Has Selector
> One line of CSS.

**Key insights:**
:has() is the parent selector . .plan:has(:checked) styles the whole card when its own radio is checked. For twenty years CSS only looked down and forward; now it looks up. Every major browser supports it since 2023. Validation without a handler: .field:has(:user-invalid) turns the border, label and icon at once. No onChange, no error state in React. The browser already knows the email is wrong, so let it drive the styling. Escalate to the form: form:has(:user-invalid) button { opacity: .4 } greys out the submit button while any field is invalid. One rule, zero derived state. Layout follows the DOM : .app:has(aside) { grid-template-columns: 280px 1fr } grows a column when a sidebar renders and collapses when it is removed. No showSidebar prop to thread through. Quantity queries live in CSS: .grid:has(> :nth-child(n + 5)) tightens gap, padding and font size across all cards the moment a fifth one arrives. No counting items in JavaScript. The document reacts to a modal: body:has(dialog[open]) { overflow: hidden } locks scroll and a second rule dims the app behind it. Close the dialog and everything reverts on its own. No cleanup effect.

**Do / Don't:**
Do: Reach for :has() when the state already lives in the DOM: checked, open, invalid, child count. Do: Use :user-invalid instead of :invalid so errors show after the user leaves the field, not on first render. Do: Put the rule on the container so border, label and icon all update from one selector. Don't: Mirror DOM state into React state just to toggle a class the browser can already compute. Don't: Write a cleanup effect for scroll lock or dimming that a body:has(dialog[open]) rule undoes by itself. Don't: Count children in JavaScript to pick a layout when a quantity query does it in one rule.

---

## Data Table
> Your data table feels cheap because it's a grid of divs, not a system.

**Key insights:**
Sort is a tri-state , not a toggle: ascending → descending → back to original. A binary flip loses the natural order forever; a third click should restore it. Numbers must line up — use tabular figures and right-align numeric columns so every digit sits on the same grid. Proportional, left-aligned digits jitter and can't be compared at a glance. Freeze what you navigate by: keep the header sticky on vertical scroll and freeze the first column on horizontal scroll, each with a subtle shadow so labels never scroll out of reach. Treat density as a token , not a guess — one control switching row heights (e.g. 36 / 48 / 60px) gives a predictable rhythm. Zebra stripes help at comfortable spacing; collapse to a single hairline as rows compact. Make the whole row the selection target — full tint + an accent left bar + the checkbox — instead of a tiny checkbox-only hit area that's easy to miss. Signal partial selection with a select-all state that morphs empty → indeterminate (dash) → checked, so bulk actions read at a glance.

**Do / Don't:**
Do: Right-align numeric columns with tabular figures so values form a scannable vertical grid. Do: Keep the header sticky and freeze the first column so labels stay anchored while scrolling. Do: Expose row density as one token-driven control for consistent, predictable spacing. Don't: Ship a binary sort that strips the original order with no way back to natural sequence. Don't: Rely on a tiny checkbox-only hit target when the entire row could be clickable.

---

## Destructive Actions
> Dangerous actions are a design language, not just a red button.

**Key insights:**
Hold-to-confirm turns the gesture into the safeguard: a ring fills over roughly 300ms of a held press, replacing a modal, and releasing early cancels the action entirely. Name the action on the button itself. Delete project / Keep project beats a generic Yes / No, because the verb is the warning and nobody reads 'Are you sure?'. Never place a destructive button where confirm usually lives. Muscle memory clicks primary spots blind, so moving delete elsewhere keeps autopilot from reaching it. Red is a budget : spend it on destruction only. A red logout button cries wolf, and then the real delete looks routine. Bury deletion in a bordered, labeled danger zone at the bottom of the page. Geography itself becomes friction that slows the hand. Give irreversible deletions a cooldown : schedule it with a grace period (for example 14 days to cancel). Time is the last line of defense.

**Do / Don't:**
Do: Name the destructive action on the button so the verb itself does the warning. Do: Reserve red for destructive actions only, and add friction like a hold gesture or a danger zone. Do: Give irreversible deletions a cancelable cooldown before they take effect. Don't: Place destructive buttons where the confirm button usually sits. Don't: Rely on a generic 'Are you sure?' dialog that nobody actually reads. Don't: Spread red across logout, badges, and alerts until delete looks routine.

---

## Disabled Buttons
> The button is disabled, and nobody tells you why.

**Key insights:**
A disabled button drops out of the tab order , so keyboard users skip right past it and screen readers stay silent. The block exists, but nothing announces it. Pointer events are dead on a disabled element, so a tooltip meant to explain the block never fires. The reason is unreachable by design. Greyed-out labels usually fail contrast. A disabled state can land near 1.9:1, well under the 4.5:1 threshold, so the text is hard to read on top of being blocked. Keep the button live and validate on click instead. Light up the fields that are blocking submit, then move focus to the first one so the path forward is visible. Disabled and loading are different states. During a request, hold focus, show a spinner, and report aria-busy ; greying the button out throws the user's place away.

**Do / Don't:**
Do: Keep the button enabled, validate on click, then flag the blocking fields and move focus to the first one. Do: For async actions, use a busy state that holds focus, spins, and sets aria-busy. Do: Name the blocker in reachable text, not a tooltip attached to a dead control. Don't: Disable submit and leave the user to guess what is missing. Don't: Rely on a tooltip to explain a disabled control, since pointer events never fire on it. Don't: Treat loading as disabled; greying out mid-request drops focus and the user's place.

---

## Drag And Drop
> The board does the thinking: moving a card is moving state.

**Key insights:**
A grabbed item needs to feel like it left the surface. Confirm the lift with three cues at once : a slight scale-up, a deeper shadow, and a small tilt. Drop zones speak first. Reveal where the item will land before release, not after — the drag should never feel like a guess. Match the drop-zone cue to its scope: an insertion line to slot between existing items, a filled highlight to land inside a whole column. On structured surfaces, snap the item to the nearest valid slot; reserve free positioning for canvases where any coordinate is valid. While dragging on a snapping surface, expose the valid target slots (dashed outlines) so the destination is never ambiguous. A drag is easy to fumble. Pair every drop with a short undo toast (~5 seconds) so a wrong move costs one click, not a redo.

**Do / Don't:**
Do: Confirm pickup with scale, shadow, and tilt together so the grab reads instantly Do: Highlight the exact drop target during the drag, before the user lets go Do: Offer a brief undo after a drop so a misdrop is one click to reverse Don't: Snap a released card into place with no lift or shadow — it feels like nothing happened Don't: Force pixel-precise placement when snapping to a valid slot would do the work Don't: Make a wrong drop permanent with no way to reverse it

---

## Dropdown Design
> Your dropdown is broken.

**Key insights:**
Make the trigger obviously clickable : a 48px touch target, a visible caret icon, and a real hover state — not a 30px box with a faint border. Flip on edge — when there isn't enough room below the trigger, open the menu upward so it never clips off-screen. Keyboard support isn't optional : arrow keys move the highlight, Enter selects the item, and Esc closes the menu. Once a list passes ~10 items , add a search field so users filter instead of scroll-hunting. Animate the open in around 150ms — 50ms feels instant and cheap, 500ms drags and feels sluggish.

**Do / Don't:**
Do: Give the trigger a 48px touch target, a clear caret, and a visible hover state. Do: Open the menu upward when space below the trigger runs out. Do: Wire up arrow keys, Enter, and Esc for full keyboard control. Don't: Ship a 30px, low-contrast trigger with no hover feedback. Don't: Let a long menu clip off the bottom of the viewport. Don't: Animate slower than ~150ms — or with no transition at all.

---

## Filter Chips
> Chips 200 results.

**Key insights:**
Give every chip three distinct visual states — idle (surface + border, tappable but not chosen), active (filled + check, clearly selected), and disabled (dimmed, no results behind it). If active looks like idle, the filter feels broken. Make the combination logic legible: OR within a group widens the net (more colors = more matches), AND across groups narrows it (adding a size filters the set down). Update the result count on the same frame as the tap. If the number doesn't move, users read it as 'nothing happened' and tap twice. Always ship a single clear-all reset. Stacked filters trap users, and one tap back to zero is the escape hatch — pair it with a live count so the reset is legible. When chips outrun the screen, keep them in one horizontal scrolling row with a right-edge fade that hints at more. Wrapping into a multi-row wall buries the results below the fold. Pin active filters in a sticky summary bar on top so users can always see why the list shrank.

**Do / Don't:**
Do: Update the result count instantly on every tap, same frame as the state change Do: Give each chip clearly distinct idle, active, and disabled states Do: Offer a single clear-all reset paired with a live result count Don't: Let active chips look identical to idle ones — the filter reads as broken Don't: Wrap overflowing chips into a multi-row wall that pushes results off-screen Don't: Leave the count unchanged after a tap — users assume it failed and tap again

---

## Hover Trap
> Hover works on your laptop but is dead on mobile.

**Key insights:**
Touch has no hover, so the browser fakes one: the first tap is spent becoming a sticky hover that freezes the revealed actions in place until the user taps somewhere else. Never bury a primary action behind hover. Hover should surface extras only, never something the user cannot otherwise reach. Give hover-only actions a touch-reachable home: put them in the card , behind a swipe , or inside a bottom sheet . Gate hover styles with @media (hover: hover) instead of sniffing the user agent, so a tablet with a mouse still gets the full treatment. Pair it with pointer: coarse to grow controls when the pointer is a thumb rather than a mouse. A 20px icon passes design review but misses the thumb. Pad the hit area to 44px and keep the glyph small.

**Do / Don't:**
Do: Reveal only secondary extras on hover, keeping every primary action reachable by tap Do: Gate hover effects behind @media (hover: hover) so pointer capability decides, not device type Do: Pad tap targets to 44px while keeping the visible icon around 20px Don't: Hide primary actions behind a hover state that touch users can never trigger Don't: Detect touch by sniffing the user agent instead of querying the pointer Don't: Size the tap target to the 20px icon and leave the thumb missing

---

## Inline Editing
> Click the title.

**Key insights:**
Editable text has to whisper its affordance: a pencil on hover, a soft background tint. With no signal, people file support tickets just to rename a title. Keep every pixel in place during the swap. Same font, same size, same padding, with the border going from transparent to accent. One jump and the illusion collapses. Enter commits, Escape cancels , and everyone agrees on that. Blur is the contested one: some apps save on click-away, others discard. Pick one rule and never break it. Save optimistically : the text updates on screen while the request is still in flight. If the server fails, roll back, keep the draft, and say why. Match the editing mode to the cost of a typo. Make every cell editable when mistakes are cheap, or require an explicit Edit action when they are expensive.

**Do / Don't:**
Do: Signal editability on hover with a pencil icon or a soft background tint. Do: Update the UI immediately, then roll back and keep the draft if the save fails. Do: Keep font, size, and padding identical between the text and the input. Don't: Leave editable text with zero affordance, so users cannot tell it is editable. Don't: Change what blur does from one screen to the next (save here, discard there).

---

## Live Cursors
> Three cursors land on your canvas.

**Key insights:**
The server streams roughly 10 positions a second while the screen redraws at 60fps. Interpolation fills the gaps so cursors glide instead of teleporting between discrete points. Give every user a color hashed from their ID , not assigned at random. The same person keeps the same color across sessions, so you can track identity from the corner of your eye. An avatar stack with an overflow counter (three faces, then a +5) signals presence before anyone edits or speaks. You feel the room before you read a single name. When someone selects an element, lock it and outline it in their color. Two people editing one shape is a corrupted shape, so the lock prevents the conflict before it can exist. Follow mode binds your viewport to another user's: click their avatar and their pans and zooms drive your screen. It replaces a screen share for live design review.

**Do / Don't:**
Do: Interpolate cursor positions between server ticks so movement reads as smooth motion at 60fps. Do: Derive user color from a stable hash of the ID so it survives across sessions. Do: Lock an element the instant it is selected and badge it in the editor's color. Don't: Render cursors at the raw server tick rate, which makes them jump between points. Don't: Assign colors randomly per session, which resets identity every time someone rejoins. Don't: Allow two users to edit the same element at once.

---

## Modal Hierarchy
> Hierarchy 5 overlays.

**Key insights:**
Start with one question: does it block the user? If yes, reach for a modal; if no, choose by context — sheet, popover, or drawer. A modal takes over the screen with a full scrim and centers a single decision. Reserve it for critical or destructive choices (like "Delete account?") that must be answered before anything else. A bottom sheet is the mobile-first default: it slides up from the bottom edge, supports a drag handle and snap points, and keeps the screen behind it partly visible so users don't lose context. A drawer is an edge-anchored panel for navigation — it slides in from the side, dims only the area it covers, and leaves the app alive behind it. A popover anchors to the element that triggered it and stays small and contextual (~200px). Use it for lightweight menus and quick actions, never for blocking flows. Match weight to intent : modals interrupt, popovers and sheets stay non-blocking. Reaching for a modal when a popover would do adds friction to routine actions.

**Do / Don't:**
Do: Ask "does this block the user?" before picking any overlay. Do: Reserve modals for critical or destructive decisions that demand a response. Do: Anchor popovers to their trigger and keep them small and contextual. Don't: Reach for a modal when a lightweight sheet or popover would do the job. Don't: Use a full-screen scrim for a routine, non-blocking action. Don't: Bury navigation inside a blocking overlay — use an edge drawer instead.

---

## Peak End Rule
> One line of CSS.

**Key insights:**
The brain doesn't average a flow — it stores the most intense moment (the peak) and the final moment (the end), then judges the whole from those two points. Two flows with an identical average satisfaction are remembered completely differently based on how they finish — same middle, opposite memory. Engineer at least one intentional peak : a surprise upgrade, a free perk, a moment of delight. One delight outweighs five neutral steps. The ending carries disproportionate weight — a joyful last screen beats a flat, cold confirmation for the exact same effort. The reverse also holds: a broken or error-filled final step tanks the memory of an otherwise smooth experience. Stop trying to make every step equally good — concentrate your effort on the peak and the end.

**Do / Don't:**
Do: Engineer a deliberate peak — a surprise or moment of delight partway through the flow. Do: End on a high note: celebrate success on the last screen instead of a flat confirmation. Do: Audit the final interaction of every flow — it weighs heaviest in what users remember. Don't: Spread effort evenly across every step while neglecting the finish. Don't: Let a flow end on friction, an error, or a cold dead-end.

---

## Search Experience System
> Search is a system.

**Key insights:**
Placeholder copy is your first onboarding. "Search" tells the user nothing; "Search by name, SKU, or brand" tells them everything they can look for. An empty field isn't empty. Load recent searches the moment the user focuses the bar so a single tap refills it and friction drops to zero. Rank autocomplete by clicks, not alphabet , and tag each suggestion with a category badge. Three sharp results beat ten noisy ones. Make the whole flow keyboard-driven : arrow keys move through results, Enter selects, Escape closes. Keep the focus ring visible at every step — invisible focus quietly breaks both keyboard navigation and accessibility. Zero results should never be a dead end. Offer popular searches, category jumps, or alternate spellings so users recover at the exact moment they'd otherwise bounce.

**Do / Don't:**
Do: Write descriptive placeholder text that hints at what's actually searchable Do: Surface recent searches on focus so returning users refill the bar in one tap Do: Turn zero-result screens into recovery paths with suggestions and category jumps Don't: Ship a bare "Search" as your only placeholder Don't: Sort autocomplete alphabetically instead of by popularity Don't: Leave a "No matches" screen as a dead end

---

## Star Rating
> Five stars looks trivial.

**Key insights:**
Preview on hover , don't wait for the click. Stars should fill ahead of the cursor so users see the value they're about to commit — a widget that only reacts on click hides the target until it's too late. Keep the preview state separate from the committed value . When the pointer leaves without clicking, snap the display back to the saved rating; a naive build leaves it stuck on the last hovered star. For averages, render fractional stars — a 4.4 is four full stars plus a fifth clipped to 44%. Rounding it up to five full stars is a lie that inflates perceived quality. Stagger the fill ~30ms per star , left to right. Popping all five at once feels flat and lifeless; the sequential sweep feels alive. Use fractional fill for input precision too — clumsy whole-star jumps read as cheap next to a smooth half-star land. Stars are the input; pair them with a summary view (an average ring plus a distribution breakdown) to communicate the aggregate score at a glance.

**Do / Don't:**
Do: Fill stars ahead of the cursor on hover so the value previews before commit Do: Render partial fills so a 4.4 shows four stars plus a 44%-filled fifth Do: Stagger the fill roughly 30ms per star, left to right, when a rating commits Don't: Round averages up to full stars — it misrepresents the real score Don't: Leave the preview stuck on the hovered value after the pointer leaves Don't: Pop all five stars simultaneously — it reads as flat and dead

---

## Swipe Actions
> Engine · $79 The Claude Code plugin that builds this pattern correctly: states, hierarchy, copy, with eight skills of senior-designer reasoning.

**Key insights:**
Swipe actions are invisible UI. Without an affordance hint (a peek of the action on first scroll, an onboarding nudge), most users never discover them. Destructive swipes need friction: a full swipe that instantly deletes is a data-loss bug waiting to happen. Reveal the button on partial swipe, require a tap (or full-swipe + undo toast) to commit. Color-code by consequence: neutral actions on surface tones, destructive on red — and keep the mapping consistent across every list in the app. Never make swipe the only path. Every swipe action needs a visible fallback (long-press menu, detail-view button) for discoverability and accessibility.

**Do / Don't:**
Do: pair each swipe action with an undo window, and keep left/right semantics consistent app-wide. Don't: hide more than two actions per side — beyond that, users can't build muscle memory.

---

## Tooltip Design
> Your tooltip is annoying.

**Key insights:**
Add a 300ms delay before a hover tooltip appears, so it doesn't fire on every accidental cursor graze across the trigger. Anchor the tooltip to its trigger with an arrow . Without one, a floating label sitting above a row of icons leaves users guessing which element it actually describes. Flip the tooltip to the opposite side when the trigger sits near a viewport edge — otherwise it gets clipped off-screen instead of staying readable. Make it dismissible everywhere : mouse leave, the Escape key, focus out (blur), and a tap outside should all close it. Every escape route matters. Keep the copy tight — cap the width around 300px and hold it to one sentence. If you need a documentation paragraph, it's not a tooltip anymore.

**Do / Don't:**
Do: Wait ~300ms before revealing a hover tooltip Do: Point at the trigger with an arrow so the reference is unambiguous Do: Flip position near viewport edges to prevent clipping Don't: Fire instantly on every cursor graze Don't: Cram multi-line, documentation-length text into a single tooltip

---
