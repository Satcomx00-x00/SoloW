# Forms Patterns

## Autosave Ux
> Your settings page is harmless until the last section.

**Key insights:**
Never write on every keystroke. Start a debounce timer when typing pauses, reset it on each key, and commit one clean write after roughly 800ms of silence. Model the status indicator as a state machine with clear states: typing, saving, saved, offline, error. Users trust the pill more than the feature itself, so never let it read 'Saved' when the write never landed. When the connection drops, push every edit into a local queue and surface a badge counting what is pending. On reconnect, drain the queue in order, oldest first. Two tabs on one document means last write wins can silently erase an hour of someone's work. Merge concurrent changes or warn the user, but never overwrite in silence. Guard the exit. If unsaved work exists, use the browser's beforeunload prompt to intercept the closing tab. One ugly dialog beats an afternoon retyped.

**Do / Don't:**
Do: Debounce writes so one clean save fires after a pause (around 800ms), not on every keystroke. Do: Queue edits locally while offline and replay them oldest first once the connection returns. Do: Keep the status honest by mapping it to explicit states and updating it in real time. Don't: Let the pill show 'Saved' when the change never reached the server. Don't: Overwrite a concurrent edit silently; merge the changes or warn instead. Don't: Let a tab close on unsaved work without a confirmation dialog.

---

## Date Pickers
> Pickers Same date.

**Key insights:**
Presets cover ~90% of cases. Offer Today, Yesterday, Last 7 days, Last 30 days, and Last quarter as one-click options, and reserve a custom range for the remaining edge cases. For custom ranges, make selection legible: hovering paints a live preview , the first click locks the start, the second locks the end, and the edges stay draggable to refine without starting over. Show two months side by side so a range can cross the month boundary naturally — never force users to click "next" four times to reach a nearby date. Widen to three months on large screens. Support the full keyboard : arrows move focus across the grid, users can type the date directly, Enter confirms, Escape closes, Page Up jumps a month, and Shift+Page Up jumps a year. Mobile is not a popover. Use a full-screen sheet that scrolls vertically, keep today anchored at the top, and place a large confirm button at the bottom within thumb reach.

**Do / Don't:**
Do: Lead with presets for common ranges and keep a custom option only for the exceptions Do: Render two calendar months at once so ranges can span the month boundary Do: Wire up the full keyboard — typing, arrow navigation, Enter/Escape, and month/year jumps Don't: Force repeated "next" clicks to reach a month that's only a few weeks away Don't: Shrink the desktop popover onto mobile instead of using a full-screen sheet

---

## File Upload Ux
> UX Same file.

**Key insights:**
Upload is a system of states — drag feedback, honest progress, error recovery, preview, and queue — not a bare file input. A dropzone has to answer back the moment a file hovers over it. Border, glow, and copy shift give three signals before the drop, so users never hesitate over a dead zone. A spinner hides the truth. Show percent complete and time remaining so the user can decide to wait or walk away. When an upload dies at 90%, never make them start over. Inline retry keeps the file loaded and resumes in one tap. A filename is not feedback. Show the thumbnail, type, and size as visual proof you received the right file. In a multi-file queue, each item gets its own progress and its own retry — one failure never blocks the other nine.

**Do / Don't:**
Do: React to drag-over with a border, glow, and copy change before the drop Do: Show percent complete and estimated time remaining during upload Do: Offer inline retry that keeps the file loaded so one tap resumes Don't: Rely on a spinner that hides how far along the upload really is Don't: Force users to re-select and start over after a failed upload Don't: Treat a bare filename as confirmation the right file arrived

---

## Form Field States
> Six field states, one system.

**Key insights:**
A text field has six states — default, focus, error, success, disabled, and loading — and each needs an explicit design. Forget one and it becomes a bug in production. At rest, keep the label outside the field with helper text below it. A placeholder-as-label vanishes the moment someone starts typing. On focus, make the active target obvious with a focus ring of at least 3:1 contrast . A soft blue glow looks pretty but fails accessibility checks. For errors, combine color + icon + message together — a border-only red is invisible to the ~12% of users with color-vision deficiency. Name what's wrong and how to fix it. Confirm success inside the field , where the user's attention already is. Toasts steal focus and disappear before they're read. Keep disabled and loading visually distinct : disabled uses a grayscale fill with a not-allowed cursor, while loading shows an in-field spinner and blocks input to prevent double submits.

**Do / Don't:**
Do: Place the label above the field and helper text below, so nothing disappears on input Do: Signal every error with color, an icon, and a written message at once Do: Disable the input and show a spinner during async checks to stop double submits Don't: Use a placeholder as the label — it vanishes as soon as typing begins Don't: Rely on a border-only red for errors; roughly 12% of users won't perceive it Don't: Fake a disabled state with opacity 0.5 — it reads as a loading state instead

---

## Form Validation Timing
> The error fires while you're still typing.

**Key insights:**
Validating on submit is too late — users fill ten fields, commit, then get hit with a wall of errors all at once. Validating on every keystroke is too early — it flags a field as wrong before they've even finished typing the word. The sweet spot is on blur : check a field the moment focus leaves it, so feedback lands after they're done but before they submit. Once a field has errored, switch to live validation for that field so the error clears the instant they correct it. Success is feedback too — a green check tells users a field is right, not only when something's wrong.

**Do / Don't:**
Do: Validate a field on blur, once the user has moved on from it. Do: After a field errors, revalidate live so the message clears the moment it's fixed. Do: Confirm correct fields with a green check, not just flag the broken ones. Don't: Hold every error until submit and reveal them all at once. Don't: Fire red errors on each keystroke before the user finishes typing.

---

## Input Masking
> Type 16 digits.

**Key insights:**
Group digits four-by-four. Inserting a space every four characters turns an unreadable 16-digit run into scannable chunks like 4242 4242 4242 4242. The leading digit names the brand — 4 is Visa, 5 is Mastercard, 3 is Amex. Surface the matching card mark inline as the user types. When you auto-insert a separator, keep the caret right after the character just typed. Jumping it to the end of the field is disorienting and breaks editing. Validate on blur, not on keystroke. Flagging "Invalid card" while someone is mid-entry reads as premature; stay neutral until they leave the field, then confirm success. Strip junk on paste. When a value arrives with dashes or spaces, clean it and reformat to your own grouping instead of rejecting it. Show formatted, store raw. Render the grouped value for the user, but persist the unformatted digits (no spaces or dashes) as the stored value.

**Do / Don't:**
Do: Group long numbers into fixed chunks so they stay readable as they're typed Do: Detect the card brand from the leading digit and show its mark inline Do: Reformat pasted values instead of erroring on their separators Don't: Let the caret jump to the end when a separator is auto-inserted Don't: Flag a validation error on the first keystroke instead of waiting for blur Don't: Save the formatting characters with the value — keep the stored data raw

---

## Otp Input
> OTP input is a system, not six boxes.

**Key insights:**
Treat paste as the primary path: when a code is pasted into any box, strip spaces and non-digits ( value.replace(/\D/g, "") ) and distribute the digits across all six boxes at once. Auto-advance focus as each digit lands, and make backspace on an empty box jump back to the previous one and clear it — so correcting a typo never traps the cursor. Model the field as one string , not six independent values. useState("847291") beats useState(["","","","","",""]) ; the boxes are just a view of a single source of truth. On mobile, wire up inputmode="numeric" and autocomplete="one-time-code" so the OS surfaces the SMS code as a one-tap autofill above the keypad. Throttle resend behind a visible 30s countdown. Without it, impatient users spam the button, hit 429 Too Many Requests , and get temporarily banned by the server. Give instant feedback on submit: a wrong code shakes and clears back to focus, a correct code locks each box green with a check and a 'Verified' state.

**Do / Don't:**
Do: Store the full code as a single string and render the six boxes as a view of it Do: Strip non-digits from pasted input and spread the code across every box automatically Do: Gate the resend button behind a visible countdown timer to avoid rate-limit bans Don't: Rely on one wide input — pasted codes with spaces overflow and choke it Don't: Leave a wrong code sitting silently — shake, clear, and refocus instead

---

## Password Field Ux
> Eight characters, one symbol: still weak.

**Key insights:**
Strength is entropy , not a checkbox tally — a longer passphrase beats a mandatory symbol every time. Show the requirements checklist as they type and tick each rule green before they hit submit — never reveal the rules only after a failed attempt. A live strength meter coaches in real time: a growing bar says "almost," while post-submit errors only punish after the fact. Add an eye toggle to unmask the field — masked dots cause silent typos users can't catch. Never block paste — password managers fill longer, stronger passwords than anyone types by hand. The strongest pattern is to offer a generated password : one tap for a unique, saved, never-reused credential.

**Do / Don't:**
Do: Surface a live checklist and strength meter that update on every keystroke Do: Offer a visibility toggle plus a one-tap generated password Do: Allow paste so password managers can fill strong credentials Don't: Hide the rules until after submit, then punish with red errors Don't: Treat a capital-and-symbol checkbox as proof of real strength Don't: Block paste or force users to retype long passwords manually

---

## Range Sliders
> Sliders Drag to 47.

**Key insights:**
Dragging is imprecise — a finger can't reliably land on an exact value, so the readout flickers between 47 and 48. Design around that imprecision instead of pretending it isn't there. Fill the track. The filled length left of the thumb is the value, readable at a glance. A bare, unfilled track forces users to eyeball the thumb position and guess. Make the whole row draggable. A 4px hairline is a moving target that cursors keep missing — expand the hit area to the full row so grabbing the slider is effortless. Snap to steps when clean values matter. Free continuous dragging lands on ugly numbers like 47.3; snapping to defined increments (with visible ticks) keeps values round — nobody wants 47.3. Float the value in a tooltip above the thumb while dragging, so the exact number stays visible right where the eye already is. Support a two-thumb range with a filled band between the handles for min/max cases like price filters, and make it keyboard-operable : arrows step by one, Home and End jump to the extremes.

**Do / Don't:**
Do: Show a filled track plus a live readout so the value is legible without guessing Do: Expand the drag target to the full row instead of just the thin track Do: Snap to steps and float a value tooltip above the thumb while dragging Don't: Rely on a 4px hairline as the only hit target Don't: Leave a slider continuous when users need clean, round values Don't: Ship a slider that can't be driven with arrow keys, Home, and End

---

## Settings System
> Your settings page is harmless until the last section.

**Key insights:**
Match the apply model to the blast radius. Light toggles commit instantly with a saved confirmation, while identity fields like email demand an explicit Save/Cancel that a real click completes. Group by task, not org chart. A flat list of twenty rows becomes three scannable sections the moment it mirrors user intent instead of your data model. Make it searchable. Power users never scroll, they search, and one query beats digging through six nested menus. Give every changed value a modified indicator plus a per-setting reset , so someone can revert one override without nuking the rest. Quarantine destructive actions. Put delete behind a visual wall at the bottom of the page, and gate it behind typing the exact resource name so a stray click can't fire it. Collapse advanced options behind an expandable section, keeping the common path short while the depth stays one click away.

**Do / Don't:**
Do: Match a setting's apply model to its stakes: instant for low-risk toggles, explicit save for identity. Do: Require typing the resource name before an irreversible delete goes through. Do: Surface a reset affordance next to any value the user has changed. Don't: Pour every option into one flat list ordered by your schema. Don't: Let irreversible actions fire on a single unguarded click. Don't: Bury settings in nested menus when a search box would find them instantly.

---

## Stepper Wizard
> Twelve fields, one wall.

**Key insights:**
Chunk long forms into small groups — three fields read effortlessly, but twelve in a row trigger scroll fatigue. Splitting the flow lowers cognitive load before it breaks it. Group fields by context, not by count — Personal, Shipping, Payment, Review. Each step should earn its own screen; splits made on an arbitrary number feel random. Always show progress . Pick one indicator — a linear bar, numbered dots, or step labels — so users can feel the end getting close. Validate inside each step , not at the end. A bad email on step one shouldn't surface on step four; block the Next button while a field is still invalid. Prefer inline errors over final-screen rejection — an immediate red message beats bouncing users all the way back after they thought they were finished. Persist state on every step change. Back navigation and a page refresh must preserve entered data — lose the form once and you lose the user.

**Do / Don't:**
Do: Split forms into steps grouped by meaning like Personal, Payment or Review, not by an arbitrary field count. Do: Show a progress indicator and validate each field within its own step. Do: Save entered data so Back and Refresh never wipe the user's progress. Don't: Surface a step-one error only once the user reaches the final step. Don't: Let a refresh or the Back button discard everything already typed. Don't: Stack twelve fields into one scrolling wall when they can be chunked into steps.

---

## Toggle Anatomy
> Two toggles.

**Key insights:**
Proportions hold the shape together: make the rail twice the knob's diameter, and pad the knob by its own radius so it sits centered in both states. A good toggle morphs, it doesn't snap — animate the flip over ~250ms with an ease-out curve instead of jumping instantly between on and off. Four properties change at once during the flip: rail color, knob position (translateX), knob shadow, and the state label — all moving together, not in sequence. Build in accessibility : Space toggles the control when focused, a visible focus ring shows keyboard position, and aria-checked lets screen readers announce the state. For async toggles, go optimistic — flip immediately on click, spin a loader inside the knob while the request is pending, then roll back (with a shake and an error toast) if the server fails.

**Do / Don't:**
Do: Morph rail color, knob position, shadow, and label together over ~250ms with an ease-out curve. Do: Flip optimistically, show a spinner inside the knob while pending, and roll back on failure. Do: Support Space to toggle, a visible focus ring, and aria-checked for screen readers. Don't: Snap the knob instantly between states — the hard jump reads as broken, not responsive. Don't: Leave the toggle ambiguous during a network request — an un-spun switch looks stuck. Don't: Ship a toggle that only responds to a mouse click and skips keyboard and screen-reader users.

---
