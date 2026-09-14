# Feedback Patterns

## Doherty Threshold
> Cross 400ms and your user checks out.

**Key insights:**
The Doherty Threshold is 400ms: respond faster and you hold attention, respond slower and users mentally disconnect. Response time splits into zones — under 200ms feels instant, 200–400ms is tolerable, and over 400ms starts breaking engagement. What matters is perceived speed, not raw speed — the real work can take longer as long as the interface reacts within the threshold. Skeleton loading paints placeholder shapes the instant a screen opens, so it never looks frozen while data arrives. Optimistic UI updates the screen as if the action already succeeded, then reconciles only if the server rejects it. Progress feedback — spinners, progress bars, inline status — keeps an unavoidable wait feeling responsive instead of stalled.

**Do / Don't:**
Do: Give visible feedback within 400ms of any interaction, even if it's just a skeleton or acknowledgment Do: Update the interface optimistically for actions that almost always succeed Do: Show progress feedback whenever the real work has to exceed the threshold Don't: Leave the screen blank or frozen while data loads in the background Don't: Wait for a server round-trip before giving any visual response

---

## Error States
> States Same error.

**Key insights:**
Match the error type to its surface. A validation error belongs inline under the field, a lost connection reads as a banner or toast, and a server crash or permission block needs its own prominent space — each type has a natural home. Let severity drive the surface. Minor issues stay inline, transient ones surface as a toast, and blocking failures earn a modal. The more an error interrupts the user, the more space it should occupy — and the reverse. Every error needs an exit. A dead-end 'OK' button leaves people stuck. Give a real way out — a Retry , a link to support, or expandable technical details for those who want to dig in. Write copy for humans, not machines. 'Error 500 — An error occurred' tells the user nothing. Say what broke, why, and what to do next in plain, specific language. Prevent errors before they happen. Live inline validation — checking each rule as the user types and turning criteria green — stops most mistakes before submit. Validating only on submit just tells people they failed after the fact. Keep field-level validation small, inline, and specific — anchored to the input it describes, not floating in a generic alert.

**Do / Don't:**
Do: Offer a clear recovery action on every error — retry, undo, or a path to help. Do: Match the surface to severity: inline for field errors, toast for transient issues, modal for true blockers. Do: Validate inline as the user types so problems surface before submit. Don't: Ship dead-end errors whose only option is 'OK'. Don't: Surface raw codes like 'Error 500' or 'An error occurred' with no guidance. Don't: Interrupt a minor validation slip with a full-screen modal.

---

## Loading States System
> Stop using skeletons for everything.

**Key insights:**
Loading is a system : match the pattern to what you actually know about the wait — its shape, its duration, its progress. One default (usually a skeleton) applied everywhere is the tell of a lazy UI. Skeletons are for when you know the content's shape — cards, lists, articles — and the wait exceeds ~300ms. They set the right expectation by previewing the layout that's about to load. Spinners fit short waits of unknown duration, under ~3s (a button saving, a small fetch). Never stretch one across a full-page load — an endless spinner with no context reads as frozen. Progress bars belong to waits over ~3s where you know the percentage — uploads, installs, exports. Pair the bar with real meta (time remaining, speed) so the number earns the user's trust. Optimistic UI is the pro move for reversible actions like likes, saves, and bookmarks: update the interface instantly, then reconcile with the server in the background and only surface an error if the sync fails. Under ~300ms, show nothing at all . A brief flash of a loading state feels more broken than a slight delay — the eye registers the flicker as a glitch, not as feedback.

**Do / Don't:**
Do: Pick the pattern from what you know: known shape → skeleton, known percentage → progress, short unknown wait → spinner. Do: Apply the response instantly for reversible actions, then sync in the background and roll back only on failure. Do: Let sub-300ms responses land with no loading indicator at all. Don't: Reach for a skeleton on every fetch regardless of the content shape or how long it takes. Don't: Cover a whole page with a spinner for long or open-ended loads. Don't: Flash any loading state for a response that resolves in under 300ms.

---

## Notification System
> Notifications are a system.

**Key insights:**
A notification isn't one component — it's a system of four surfaces : toast, banner, modal, and badge. The same content can be delivered at four different volumes. The trigger picks the volume. Let the event's severity decide the surface: a low-priority "new message" fits a toast, a degraded-service warning a banner, a blocking "card declined" error a modal, and a passive unread count a badge. Persistence is part of the contract. Toasts auto-dismiss in a few seconds (and should offer undo), banners stay until manually cleared, modals block until the user acts, and badges sit quietly until the count is resolved. Stack behavior separates good from broken. Several toasts can stack and breathe; several modals become a trainwreck — blocking dialogs must never queue on top of each other. Over-escalating backfires: route everything to the loudest surface and you get zero attention , because users learn to tune the noise out.

**Do / Don't:**
Do: Map each notification's severity to the surface that matches it — toast, banner, modal, or badge. Do: Let toasts auto-dismiss with an undo affordance, and reserve modals for actions that genuinely must block. Do: Stack low-priority notifications so they breathe instead of piling up on screen. Don't: Route every alert to the most intrusive surface — over-escalation trains users to ignore all of them. Don't: Queue multiple modals on top of each other; blocking dialogs stacked together are a trainwreck. Don't: Use a blocking modal for a low-severity, purely informational message.

---

## Optimistic Ui
> UI Click like.

**Key insights:**
Update the UI the instant the user acts, then sync with the server in the background — don't block on the response. The brain reads anything under 400ms as instant; a spinner past that threshold makes the action feel broken. When the request fails, roll back the UI cleanly — undo the like, restore the count, as if it never happened. The core bet: trust the success case (which is almost always what happens) and handle the rare failure gracefully. Reserve it for reversible, low-stakes actions — likes, toggles, reorders — where an occasional rollback costs nothing.

**Do / Don't:**
Do: Update the interface immediately, then reconcile with the real server response behind the scenes. Do: Roll back to the previous state the moment a request fails, so the UI never lies for long. Do: Apply it to reversible interactions like likes, favorites, and list reordering. Don't: Use it for payments, transfers, or anything you can't safely undo. Don't: Show a charge, booking, or confirmation before the server has actually cleared it.

---

## Skeleton Loading
> Engine · $79 The Claude Code plugin that builds this pattern correctly: states, hierarchy, copy, with eight skills of senior-designer reasoning.

**Key insights:**
A spinner tells users "something is happening" but gives zero information about what or how long . That uncertainty is what makes waits feel slow. Skeleton screens preview the shape of the incoming content — avatar circle, text bars, image block — so the brain starts parsing the layout before the data arrives. The shimmer sweep matters: a static skeleton reads as "broken", an animated one reads as "in progress". Match the skeleton to the real content dimensions. A skeleton that jumps to a different layout on load is worse than a spinner. For actions the user just performed (posting, liking), skip loading states entirely — render the result optimistically and reconcile in the background.

**Do / Don't:**
Do: shape skeletons to mirror the final layout, animate them, and keep them under ~2 seconds before showing partial content. Don't: use skeletons for sub-300ms loads (flash of skeleton is noise) or mix spinners and skeletons in the same view.

---

## Toast Notifications
> Toasts done right: five rules for notifications that inform without blocking.

**Key insights:**
Position deliberately: bottom-right on desktop, top edge on mobile. The screen center is off-limits — it covers the content users are actively working on and blocks clicks. Match dismiss timing to severity : routine info auto-dismisses in ~4s, warnings hold ~7s, and critical errors stay until the user acknowledges them. Cap the stack at 3 visible toasts — newest enters at the bottom, older ones float up and out, and the rest queue. Spring motion keeps the shuffle readable. Always give a way out : a close button on desktop, swipe-to-dismiss on mobile, and a timer that pauses on hover so people can finish reading. Color-code by type (info, success, warning, error) but never rely on color alone — pair each with an icon and accent border, since ~6% of users can't tell the colors apart.

**Do / Don't:**
Do: Anchor toasts bottom-right on desktop and to the top edge on mobile Do: Pause the auto-dismiss countdown while the user hovers so they have time to read Do: Reinforce each type's color with a matching icon and left accent border Don't: Place toasts in the screen center, where they block the content users are working on Don't: Auto-dismiss critical errors — hold them until the user acknowledges Don't: Show more than three toasts at once; queue the rest instead of piling them up

---

## Undo Ux
> Cross 400ms and your user checks out.

**Key insights:**
Undo beats confirmation. "Are you sure?" punishes everyone for one person's mistake; undo punishes nobody. The action happens instantly, and regret gets a second chance. Soft delete means the file left the screen, not the database. Set a deleted flag, keep it in trash for thirty days, then purge. Deletion is a state, not an event. Friction belongs only where there's no way back. For truly irreversible actions, make users earn it — GitHub requires typing the repo name before deleting it. One undo is a toast; a stack is a time machine. An undo stack lets Cmd+Z walk back through every step in order, the way Figma remembers everything you did. Delayed send turns a delay into a feature. Gmail holds your email for ten seconds after send — long enough to catch the typo, the wrong recipient, or the reply-all disaster. Show the countdown. A visible timer on the undo toast (a draining ring or bar) tells users exactly how long their second chance lasts.

**Do / Don't:**
Do: Execute the action immediately, then offer a time-limited undo with a visible countdown Do: Soft-delete with a recovery window (e.g. 30 days in trash) before permanent purge Do: Reserve heavy friction like type-to-confirm for genuinely irreversible actions Don't: Block every destructive action behind an "Are you sure?" dialog Don't: Hard-delete data from the database the moment the user clicks Don't: Make the undo window so short users can't realistically react

---

## Zeigarnik Effect
> Your brain forgets what's finished, and won't stop nagging about what's not.

**Key insights:**
The mind keeps unfinished tasks in active memory and drops completed ones the moment they close — open loops keep pulling attention back. A progress meter stuck at 80% creates return pressure; a checklist shown as 100% done gives the user no reason to come back. In onboarding, deliberately leave one box unchecked — the visible gap nudges people to return and finish setup instead of vanishing. Profile-completion meters are the everyday version big platforms lean on: '80% done' becomes a persistent, low-friction pull. The effect only fires for outcomes the user actually wants — a fake 'reading progress' bar on a marketing email creates zero pull. Think of the mechanic as a loop: open it, let it pull, bring them back — open loop → pull → return.

**Do / Don't:**
Do: Leave a visible gap — an unchecked box or an 80%% meter — to invite users back Do: Tie the unfinished progress to an outcome the user genuinely cares about Do: Keep the remaining percentage salient so the open loop stays top of mind Don't: Close every loop at 100%% — a fully finished state removes any reason to return Don't: Manufacture progress on chores nobody asked for, like a reading bar on a marketing email

---
