# Motion Patterns

## Animation Timing
> Same modal, two timings: one feels premium, one feels broken.

**Key insights:**
Entrances land best at 200–300ms with a cubic ease-out — fast enough to feel responsive, slow enough to read as deliberate. Exits should be faster than entrances: pair a 250ms entrance with a ~150ms exit so dismissals feel snappy instead of dragging. Feedback on taps and button presses must fire in under 100ms — anything slower reads as lag, even when the action itself is instant. Attention -grabbing motion like notifications can run longer, 500–800ms, and use a bounce or overshoot to pull the eye. Stagger list items about 50ms apart — 30ms blurs them into one blob, 100ms makes the whole list crawl in. Match the easing curve to intent: ease-out for entrances, and reserve springs and bounce for moments that genuinely need attention.

**Do / Don't:**
Do: Use ease-out curves for entrances so motion decelerates into place Do: Make exits roughly 40% faster than their entrance so dismissals feel instant Do: Keep tap and press feedback under 100ms so the interface feels alive Don't: Stretch entrances past ~300ms — they start to feel sluggish and in the way Don't: Use symmetric in/out timing — a matched-length exit feels like the UI is dragging Don't: Reach for linear easing on entrances — it reads mechanical and cheap

---

## Card Hover Anatomy
> Anatomy Same card.

**Key insights:**
Lift with weight: raise the card ~8px on hover and stretch its shadow with it over ~ 200ms ease-out . Faster reads as twitchy, slower feels stuck. Claim the cursor: a pulsing accent border or a gradient sweep around the edge stops the card looking flat and signals it's interactive. Cascade the actions: reveal hidden buttons (favorite, cart, share) staggered ~ 60ms apart , anchored at the bottom. A reveal adds an affordance, not a new layout. Push against the glass: scale the image to ~ 1.05 inside an overflow-hidden frame while the container stays fixed — the product presses outward instead of resizing the card. The trap — keep the geometry: never scale the whole card. That shifts neighbors and breaks the grid. Animate the content, hold the footprint.

**Do / Don't:**
Do: Lift the card ~8px and grow its shadow together, using ~200ms ease-out for a sense of weight. Do: Stagger revealed actions ~60ms apart and anchor them to the card's bottom edge. Do: Scale the image to ~1.05 inside an overflow-hidden frame while the container holds still. Don't: Scale the entire card — it shifts neighboring cards and breaks the grid layout. Don't: Stack action buttons over the title or let them spill outside the card boundary. Don't: Time the lift too fast (twitchy) or too slow (stuck) — 200ms is the sweet spot.

---

## Easing Curves
> Same distance, different feel: the easing curve is what decides how motion reads.

**Key insights:**
An easing curve maps how a value changes over time. Keep the same distance and duration but swap the curve, and the motion feels completely different — that shape is what your eye actually reads. Linear moves at a constant speed. It looks mechanical and cheap, so reserve it for continuous motion like spinners or marquees — never for UI that starts and stops. Ease-out starts fast then decelerates into place. It's the safest default for elements entering the screen because it mirrors how real objects settle. Spring overshoots slightly then settles, adding a bounce that reads as alive and premium — ideal for button presses, modals, and playful confirmations. Apply the same handful of curves everywhere: button press, card cascade, sheet open. Consistent easing is a big part of why an interface feels coherent instead of stitched together. Stagger list and card entrances a few frames apart so they cascade in, rather than snapping onto the screen as one rigid block.

**Do / Don't:**
Do: Default to ease-out for elements entering the screen so they decelerate naturally into place. Do: Add a subtle spring overshoot to presses, modals, and confirmations to make the UI feel alive. Do: Stagger card and list entrances a few frames apart for a cascade instead of a single hard snap. Don't: Reach for linear easing on UI that starts and stops — it reads as mechanical and cheap. Don't: Push spring stiffness or bounce so high the element wobbles; a little overshoot sells premium, too much feels broken.

---

## Scroll Driven Animations
> Same modal, two timings: one feels premium, one feels broken.

**Key insights:**
animation-timeline: scroll() turns the scrollbar itself into an animation controller — no JavaScript, no IntersectionObserver, just two lines of CSS. animation-range sets the exact trigger point, so an animation can fire on entry, on exit, or anywhere in between the scroll. view() targets individual elements — each card or image animates the moment it enters the viewport, entirely on autopilot. Parallax that once took ~30 lines of JS and a scroll-event listener is now pure CSS: give layers different speeds with zero dependencies. Layer these on top of position: sticky to build shrinking headers, reading-progress bars, and sidebars that transform as you scroll.

**Do / Don't:**
Do: Reach for animation-timeline: scroll() and view() to tie motion to scroll position natively. Do: Combine sticky positioning with a scroll timeline for shrinking headers and reading-progress bars. Don't: Hand-roll parallax or reveals with a scroll listener and getBoundingClientRect() that CSS now drives on its own. Don't: Pull in a JS animation library for effects the browser handles in a couple of CSS lines.

---
