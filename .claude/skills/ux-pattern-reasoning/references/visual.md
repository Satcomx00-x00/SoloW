# Visual Patterns

## Border Radius
> Radius Same card.

**Key insights:**
Nested corners follow math: inner radius = outer radius − padding . When the concentric curves line up, a card reads as intentional instead of "off." Pull every value from one radius scale (4 · 8 · 12 · 16 · 24) instead of picking numbers per component — consistency is what makes UI look expensive. Scale radius with element size: tooltips ~4px, inputs ~8px, cards ~12px, modals ~16px, panels ~24px. Bigger surfaces earn bigger corners. Radius carries personality — small/sharp reads corporate , large/round reads friendly . Pick the range that matches your brand's tone. The difference is subtle but felt: off-scale, mismatched corners are exactly what separates "something's wrong here" from polished.

**Do / Don't:**
Do: Derive the inner radius from the outer radius minus padding so nested corners stay concentric. Do: Commit to a single radius scale and reuse it across every component. Do: Scale radius with element size — larger surfaces get larger corners. Don't: Pick radius values at random for each component. Don't: Nest a rounded card inside another without adjusting the inner corner. Don't: Mix a playful, oversized radius into a brand meant to feel serious — or the reverse.

---

## Charts That Lie
> Same data, opposite stories: how you draw a chart decides which truth people see.

**Key insights:**
Start every bar chart's y-axis at zero. Truncating the baseline turns a +4% change into a fake +400% explosion — the single most common way charts mislead. Match the chart to the question. Bars compare values, lines show change over time, and pie charts fall apart past ~5 slices. The question picks the form, not your taste. Aspect ratio rewrites the trend. The same rising series looks flat when squished and like a spike when stretched — balance it so the average slope sits near 45° and reads honestly. Maximize the data-ink ratio. Strip gridlines, drop shadows, 3D skew, and boxed legends, then label the line directly. Every remaining pixel should carry data. Color is encoding, not decoration. Use one hero color to spotlight the series that matters, and choose categorical, sequential, or diverging scales to fit the data type. Title the chart with the takeaway, not the metric. "Revenue flat since March" tells the story; "Quarterly revenue" makes the reader hunt for it.

**Do / Don't:**
Do: Start every bar chart's y-axis at zero, no exceptions. Do: Pick the chart type from the question you're answering. Do: Spotlight the one series that matters with a single accent color. Don't: Truncate or crop an axis to exaggerate small differences. Don't: Add gridlines, shadows, or 3D effects that encode no data. Don't: Reach for a pie chart when you have more than five slices.

---

## Color Accessibility
> Same text, same color: one is invisible.

**Key insights:**
Contrast is a ratio , not a color: the exact same off-white (#F0F0F0) reads crisp on a dark panel and disappears on a light one — the background decides legibility. Know the WCAG thresholds : aim for 4.5:1 on body text and 3:1 on large text. Below 3:1 the text degrades from 'large-only' to flat-out invisible. Most failures hide in 'decorative' muted grays — nav links, card labels, and secondary headings routinely sit at 1.5–2:1 and quietly fall below the line. Never encode meaning with color alone : for the ~8% of users with color vision deficiency, a red error and a green success collapse into the same muddy tone. Add a second signal alongside every color cue — an icon on error text, trend arrows on stats, or textures/patterns in charts — so the message survives when the color doesn't. A full pass is cheap: darken or lighten muted text to clear the ratio, then bolt an icon onto each state. Same layout, dramatically more readable.

**Do / Don't:**
Do: Check every text-on-background pair against WCAG — 4.5:1 for body copy, 3:1 for large text Do: Pair color with an icon, label, or pattern so state survives color blindness Do: Lighten or darken 'muted' secondary text until it clears the contrast threshold Don't: Rely on red-vs-green alone to separate errors from success Don't: Ship low-contrast grays for nav links and card labels just because they look sleek

---

## Dark Mode
> Same app, one inverts colors.

**Key insights:**
Dark mode is not black mode . Build on a near-black base like #121212 , not pure #000000, so shadows and depth stay visible. Signal elevation with layered surfaces : each step up gets a lighter grey (base → surface → elevated), the way shadows do the job in light mode. Desaturate accent colors by roughly 20% . Full-saturation buttons and highlights vibrate and strain the eye against a dark background. Never use pure white text. #FFFFFF glares on dark UI — calibrate it down to a soft off-white for comfortable reading. Build text hierarchy with opacity , not new colors: high-emphasis, medium, and disabled text simply step down in white opacity.

**Do / Don't:**
Do: Base your darkest layer on a near-black grey like #121212, then lighten each surface as it elevates. Do: Desaturate accent colors so buttons and highlights sit calmly against the background. Do: Dim body text to a soft off-white and use opacity tiers to separate emphasis levels. Don't: Use pure black (#000000) as the background — it flattens elevation and hides shadows. Don't: Ship fully saturated accent colors — they buzz and read as cheap on dark UI. Don't: Set text to pure white (#FFFFFF) — the glare fatigues the eyes over time.

---

## De Ai Landing Hero
> Same data, opposite stories: how you draw a chart decides which truth people see.

**Key insights:**
Gradient headline full of adjectives ("Supercharge your workflow with AI") is the first tell: a generated hero sells adjectives because it has no product to name. Switch to plain text that says what it does and for whom, like "Close the month in one afternoon" over "Bookkeeping for small teams, without the spreadsheet." The purple blob behind everything is a gradient smear added because the page needs energy from somewhere. Use a neutral background and put the only color on the product screenshot and one primary button: one accent, zero blobs. Two equal buttons ("Get started" and "Learn more", same size, side by side) split the click. Keep one primary button and turn the second into a text link with an arrow, moving the visual weight from 50/50 to roughly 90/10. Fake social proof ("Trusted by 10,000+ users" above five grey logos) is a number nobody can check next to logos nobody recognizes. Replace it with one quote: a name, a role, and a result with a unit, such as closing the month in three hours instead of a week. Three feature cards with an icon in a circle and one word each (Fast, Secure, Easy) appear on every generated page. Replace the row with one product screenshot and three annotations pointing at real UI elements. Every fix follows the same rule: the generated hero decorates because it has nothing concrete to show. Swap each decoration for the product itself and the AI look disappears.

**Do / Don't:**
Do: Name the outcome in the headline and the audience in the subtitle. Do: Give the product screenshot and the primary button the only accent color on the page. Do: Quote one customer with a role and a measurable result. Don't: Fill the headline with adjectives like supercharge, seamless, or powerful. Don't: Place two identical buttons side by side. Don't: Ship the icon-in-a-circle feature row with one-word labels.

---

## Depth Layers
> Same layout, same colors: three properties turn flat cards into real depth.

**Key insights:**
You don't need to redesign to add depth. Same layout, same colors — three CSS properties do the whole job. Layered shadows beat a single drop shadow: stack a tight one (~2px), a mid spread (~12px), and a large ambient one (~32px) to mimic how real light falls off. Parallax scroll sells distance by moving layers at different speeds — background slow, midground medium, foreground fastest (roughly 1x / 2.5x / 5x). Z-translation on hover makes an element react to the cursor: lift it toward the viewer with translateZ plus a slight scale(1.03) and a soft glow. Depth also lives in the border and shadow intensity , not just position — brightening the border on hover reinforces the lift. Stack all three techniques and the interface reads as fully dimensional while still feeling flat and clean.

**Do / Don't:**
Do: Stack multiple shadows at increasing blur and offset instead of one flat drop shadow Do: Keep hover lifts subtle — a few pixels plus ~3% scale reads as physical, not cartoonish Do: Vary scroll speed per layer so background, mid, and foreground imply real distance Don't: Redesign the layout or palette to fake depth when three properties already do it Don't: Push parallax offsets or hover scale so far they pull attention off the content

---

## Design System Kit
> Random hex and eyeballed pixels don't scale.

**Key insights:**
Swap hardcoded hex for semantic tokens like var(--brand) or var(--error) . Intent survives every redesign, and a single rename updates the whole app. Build a numbered color scale (100–900) so every shade is systematic instead of a lucky guess, then map it to semantic names such as brand, success, and error. Define a type scale with fixed sizes and weights. Same size and weight everywhere means no hierarchy; a real scale separates heading from body at a glance. Base spacing on a 4px scale — space-1=4 up to space-16=64. Random gaps like 7px, 23px, or 11px read as sloppy, while scale-based gaps feel deliberate. Standardize components as variants, sizes, and states : primary/secondary/ghost/destructive buttons, small/medium/large sizing, and default/focus/error/disabled inputs. Match motion to intent — ease-out to enter, ease-in-out to move, ease-in to exit — and keep a duration scale from 100ms micro-interactions to 500ms complex transitions.

**Do / Don't:**
Do: Store every value as a named token so color, type, and spacing stay consistent across the app Do: Build numbered scales (color 100–900, spacing 4→64) so choices are systematic, not improvised Do: Tie easing and duration to the interaction's intent — entering, moving, or leaving Don't: Hardcode raw hex or pixel values inline Don't: Pick spacing by eye, 7px here and 23px there Don't: Give every text the same size and weight, killing all hierarchy

---

## Design Tokens
> Tokens 47 changes, or just one.

**Key insights:**
Name tokens by meaning, not value . color-primary survives a rebrand, while color-blue-500 becomes a lie the moment blue turns teal. Structure tokens in three layers — primitives (raw values), semantic (meaning), and component (usage) — each referencing the layer above. Change one primitive and it cascades through every component that points to it: one edit instead of 47 hunted-down values. Define a scale and snap everything to it. A stray 13px padding or 17px gap collapses to 12 and 16, so consistency stops being a guess. Dark mode isn't inverting colors — it's swapping one token set for another . Same components, alias tokens, a completely different feel. Tokens are your single source of truth for color, spacing, and type — the design system is only as strong as they are.

**Do / Don't:**
Do: Name tokens by role — color-primary , spacing-md , font-body — so they hold through a rebrand Do: Layer tokens primitives → semantic → component so a single change cascades Do: Snap arbitrary spacing and font sizes onto a fixed scale Don't: Bake literal values into names like color-blue-500 or spacing-16 Don't: Treat dark mode as inverting colors instead of swapping token sets Don't: Hardcode raw values across components instead of referencing tokens

---

## Gestalt Laws
> Same elements.

**Key insights:**
Closure — the eye completes incomplete shapes, so icons and outlines still read even with gaps; you don't need every line drawn for a shape to register. Similarity — elements sharing a property (color, shape, size) read as one group; recoloring rows instantly splits a flat grid into Navigation, Content, and Actions. Continuity — the eye follows the smoothest path, so aligning items on a shared axis lets it flow, while scattered placement forces it to jump around erratically. Figure-Ground — blurring and dimming the background pushes a modal forward as the focal 'figure', which is what makes a dialog feel deliberate instead of floating. Common Region — a shared border or container groups elements even when they sit far apart; wrapping settings in cards signals belonging without moving them closer. These laws are pre-attentive: the brain groups and completes automatically, so working with them makes a layout feel instantly organized rather than busy.

**Do / Don't:**
Do: Give related items a shared property — color, shape, or size — so they read as one group at a glance. Do: Align related controls on a common axis so the eye flows down a single clean path. Do: Wrap loosely-placed elements in a bordered card when proximity alone can't group them. Don't: Scatter navigation or list items at varied angles and positions — the eye jumps and nothing reads as connected. Don't: Lean on a modal alone without dimming what's behind it; it competes with the background instead of standing out.

---

## Golden Ratio
> One layout looks cheap, the other expensive.

**Key insights:**
The golden ratio (1.618) turns up in seashells, galaxies and classic art — layouts built on it read as naturally balanced instead of arbitrary. Build a spacing scale by multiplying a base unit by 1.618: 8 → 13 → 21 → 34 → 55. Every gap relates to the next, so the UI feels deliberate. Split the screen at the golden ratio — roughly 62% / 38% . Give primary content the larger panel and secondary actions the smaller one. Step your type scale by the same factor: 16px body, 26px subheading, 42px heading, 68px display. One rhythm ties the whole hierarchy together. It isn't just theory — teams like Stripe, Linear and Airbnb lean on the same proportional system to look polished.

**Do / Don't:**
Do: Multiply one base unit by 1.618 to derive both spacing and type scales, so everything shares a rhythm. Do: Split layouts at 62% / 38% , handing the larger share to primary content. Do: Round the results to clean pixel values your grid can actually use. Don't: Pick gaps and font sizes arbitrarily — inconsistent proportions are what read as cheap. Don't: Apply the ratio so rigidly it fights real content or your existing 8px grid.

---

## Gradient Design
> Engine · $79 The Claude Code plugin that builds this pattern correctly: states, hierarchy, copy, with eight skills of senior-designer reasoning.

**Key insights:**
Cheap-looking gradients usually travel too far across the hue wheel. Neighboring hues (teal → cyan) blend cleanly; opposites (orange → blue) create a muddy gray dead zone in the middle. Keep lightness moving in one direction. A gradient that gets darker, then lighter, then darker again reads as banding. Gradients work best as ambiance, not surface: a soft radial glow behind content beats a full-bleed linear wash on top of it. Subtle grain on top of a gradient hides banding on cheap displays and adds perceived texture.

**Do / Don't:**
Do: stay within 60° of hue travel, add 2–3% noise, and test on a low-quality screen. Don't: put body text directly on a gradient's mid-transition zone — contrast is unpredictable there.

---

## Grid System
> Align everything to a 12-column grid, then break it on purpose.

**Key insights:**
Start from a 12-column grid — it's the web standard because 12 divides cleanly into halves, thirds, quarters, and sixths, so almost any layout maps onto it. Use column ratios to structure the page: 4:8 for a sidebar plus content, 6:6 for an even split, 3:9 for a narrow nav beside a wide canvas. Gutters set the mood as much as the columns do — 8px reads dense and technical, 24px feels balanced and clean, 40px gives an editorial, premium feel. Stay responsive by dropping columns at each breakpoint: 12 at desktop, 6 on tablet, 4 on large phones, down to a single stacked column on the smallest screens. Once the grid is solid, break it on purpose — let a hero image bleed full-width or push a pull quote into the margin for deliberate emphasis. Alignment is what separates polished from amateur: chaotic, slightly-rotated elements snapped to shared column edges instantly read as designed.

**Do / Don't:**
Do: Anchor every element to shared column edges so the layout reads as intentional Do: Match gutter width to the mood — tight for dense dashboards, wide for editorial Do: Collapse columns at each breakpoint (12 → 6 → 4 → 1) so content reflows cleanly Don't: Break the grid before you've established it — a bleed only reads as intentional against order Don't: Reach for arbitrary widths when a clean column ratio like 4:8 or 6:6 already fits

---

## Icon Design Rules
> Your icons look cheap.

**Key insights:**
Optical sizing beats math: circular and organic shapes need to sit 5–8% larger than squares to read the same size — equal pixel dimensions make round icons look small. Grid alignment keeps icons crisp: snap every shape to a 24px grid (16px for dense UI), because sub-pixel drift blurs edges and kills sharpness. Stroke consistency is the fastest tell of quality: hold a single 2px weight across the whole set — mixed weights look like four different icon libraries mashed together. Bounding box stays fixed even when the shape changes: give every icon the same container so sizing reads even and toolbars stay legible. Fill vs outline is a set-wide commitment, not a per-icon choice: pick one strategy and stick to it — a random mix has no visual rule holding it together.

**Do / Don't:**
Do: Scale circular and organic icons 5–8% larger than square ones so they optically match Do: Snap every icon to a 24px grid (16px for dense UI) to keep edges crisp Do: Hold one stroke weight — 2px — across the entire set Don't: Size icons by raw math — equal boxes make round shapes look small Don't: Mix fill and outline styles at random; commit to one strategy for the set Don't: Let icons float at loose sizes — inconsistent bounding boxes make toolbars unreadable

---

## Perfect Card
> One card looks free.

**Key insights:**
Padding is the biggest tell: going from a cramped 12px to 40px with a 24px border-radius instantly reads as intentional instead of cheap. Build a real type hierarchy — push the title to 600 weight and ~38px, then shrink the body and drop it to 55% opacity so the eye lands on the title first. Stack two shadows for believable depth: a tight, darker one for contrast plus a wide, soft one for ambient elevation. Add a hairline border at roughly 12% opacity to define the card's edge against a dark background. A hover state — lift the card ~8px, scale to 1.02, and deepen the shadow — signals it's clickable and adds the final layer of polish. Same content, four changes : spacing, typography, shadows, and hover are the entire gap between a card that looks free and one that looks premium.

**Do / Don't:**
Do: Layer a tight shadow for contrast with a soft ambient one for depth, plus a subtle border around 12% opacity. Do: Set the description to ~55% opacity so the title clearly wins the hierarchy. Do: Give the card a hover lift (~8px up, slight scale, deeper shadow) so it feels interactive. Don't: Cram content against the edges with tiny padding and near-zero border-radius — it reads as an unstyled default. Don't: Give the title and body the same weight and full opacity, so nothing guides the eye.

---

## Proximity Rule
> Close = related, far = separate: spacing alone groups your UI, no borders needed.

**Key insights:**
Proximity is a Gestalt principle: elements placed close together read as one group, elements spaced apart read as separate. The eye infers relationships from distance alone. You rarely need borders, boxes, or dividers to create structure — spacing does the grouping by itself. The trick is contrast: make the gap within a group smaller than the gap between groups. Equal spacing everywhere flattens the hierarchy and everything reads as one undifferentiated block. In forms, tighten related fields (~12px) and open up section breaks (~40px) so 'Personal Info' and 'Payment' visibly separate without a single line. In toolbars and nav, group controls by function — navigate, actions, system — instead of laying them out in one evenly-spaced row. Same content, more clarity: a flat list of eight sidebar links becomes scannable the moment it's split into labeled groups like Dashboard, Management, and Account.

**Do / Don't:**
Do: Keep spacing within a group tighter than the spacing between groups Do: Group form fields and nav items by function or meaning Do: Let whitespace carry the grouping before reaching for borders or dividers Don't: Space every element equally — it erases hierarchy and forces users to parse everything at once Don't: Reach for boxes and dividers when a larger gap would communicate the same grouping

---

## Reverse Engineered Linear
> Same data, opposite stories: how you draw a chart decides which truth people see.

**Key insights:**
Density reads as competence. 13px text, 32px rows, letter spacing pulled in by 1%. The same viewport shows 14 issues instead of 8, with no scroll. Depth comes from value, not blur. Kill the shadows and stack three background values (base, surface, raised surface) separated by a 1px border at 8% white. Hover changes the surface value, not the elevation. Flat surfaces look engineered, shadows look decorated. One color, used twice. Indigo on the selected row and the primary button, nowhere else. Status is a grey icon, not a colored pill. Seven colors collapse to one and the UI instantly looks deliberate. Every action shows its shortcut. C creates, Cmd K searches. Hover feedback lands in about 80ms and transitions stay under 150ms, with no bounce or overshoot. The UI answers before you finish the gesture. A 4px grid does the rest. 16px icons centered on the text line, labels left, numbers and dates right, nothing centered. Alignment is invisible when right and loud when wrong.

**Do / Don't:**
Do: Build depth from three stacked background values plus a hairline border (rgba white at 8%), and change the surface value on hover. Do: Print the keyboard shortcut next to every action, and keep hover feedback near 80ms with transitions under 150ms. Do: Left-align labels and ids, right-align numbers and dates, and center icons on the text line using a 4px grid. Don't: Use drop shadows to separate rows, panels, or the sidebar. Don't: Encode status or priority with colored pills when a grey icon says the same thing. Don't: Let transitions bounce, overshoot, or drag past 150ms.

---

## Shadow Elevation
> Shadows aren't decoration.

**Key insights:**
Real depth comes from stacking multiple shadows , not one blur: a tight contact shadow , a mid-distance shadow, and a wide soft spread shadow layered together. The tight contact shadow ( ~0 1px 3px ) anchors the element to the surface — it's what makes the card feel physically placed rather than floating. A subtle colored glow (a low-opacity blur in an accent hue) adds a premium, branded feel that plain black shadows can't. Match the glow color to the product context — purple for creative tools, blue for fintech, green for health — so elevation reinforces brand identity. A 3D lift (perspective + a small rotateX + translateZ) adds genuine depth beyond a flat drop shadow, making the surface read as tilted toward the viewer. Elevation is a hierarchy signal : the more elevated an element, the more important it reads — which is why a premium tier looks lifted while a basic one stays flat.

**Do / Don't:**
Do: Layer three shadows — tight contact, mid-distance, and wide soft spread — for believable depth. Do: Tint the glow to your brand accent so elevation reinforces identity. Do: Reserve the strongest elevation for the elements that matter most. Don't: Rely on a single flat drop shadow for every surface. Don't: Treat shadows as decoration — they communicate depth and hierarchy.

---

## Visual Hierarchy
> Five rules that decide what your users see first, and what they skip.

**Key insights:**
Size sets the entry point: make the primary element roughly 2x the size of body text so the eye lands on it before anything else. Spend color like currency — keep the interface neutral and reserve one accent for the single most important action. A rainbow of colors flattens everything into noise. Contrast separates roles: a bold white heading against muted body copy, or a filled primary button next to a ghost secondary, makes the priority obvious at a glance. Whitespace is a signal, not filler. Give the hero element breathing room and keep secondary items compact — intentional spacing reads as importance. Font weight builds reading order without changing size: heavy for headings (800), regular for body (400), light for captions (300). No single rule carries a layout — size, color, contrast, whitespace, and weight stack to make one clear focal point.

**Do / Don't:**
Do: Reserve one accent color for the one action you want users to take Do: Make the headline about twice the size of the body text around it Do: Give the most important element more padding than everything else Don't: Color every element differently — it turns hierarchy into visual noise Don't: Lean on size alone; combine it with weight, contrast, and spacing Don't: Cram everything at equal emphasis so nothing stands out

---

## Von Restorff
> Three identical pricing cards, nobody clicks.

**Key insights:**
The isolation effect : what's visually different gets noticed and remembered. Make one item break the pattern and eyes land on it automatically. It only works against a uniform baseline — three identical cards give the eye nowhere to go. Contrast is relative, so keep everything else calm and change just one thing. In pricing, isolate the target plan : scale it up, add a "Most Popular" badge, and dim the alternatives so the choice steers itself. Break the pattern with a single CTA — one "Get Started" button lifted by color, scale, and glow pulls attention (heat maps concentrate right on it) while nav links recede. In forms, emphasize the primary action and mute the secondary ones, so the next step is never in question. Differentiate with more than color — combine scale, elevation, and glow so the standout reads reliably, including for color-blind users.

**Do / Don't:**
Do: Isolate the one action you want taken, using scale, color, and a badge against a uniform baseline Do: Keep surrounding elements visually quiet so the highlighted one truly stands out Do: Limit emphasis to a single element per view — target plan, primary CTA, or main form button Don't: Highlight two or three elements at once — competing emphasis cancels the effect entirely Don't: Ship identical options and hope users pick the one you actually want them to choose Don't: Lean on color alone; pair it with scale or elevation so the contrast holds up

---

## Z Index Mastery
> Same data, opposite stories: how you draw a chart decides which truth people see.

**Key insights:**
z-index needs position. Setting z-index: 9999 on a position: static element does nothing — give it position: relative (or absolute/fixed/sticky) and the layering finally works. Every stacking context is its own universe. A child at z-index: 9999 can never climb above its parent's siblings — if the parent sits below, the child sits below too, no matter how huge the number. A z-index arms race (9999, then 99999) is a symptom, not a fix — the real culprit is almost always an unexpected stacking context somewhere up the tree. isolation: isolate spins up a fresh stacking context in one line, so a component's internal layers stop leaking out and z-fighting with the rest of the page. Stop guessing at the order — Chrome DevTools' Layers panel renders the page in 3D so you can see which element actually sits on top.

**Do / Don't:**
Do: Give an element position: relative before expecting z-index to do anything. Do: Reach for isolation: isolate to contain a component's stacking in one clean line. Do: Open DevTools' Layers panel to inspect the real 3D stack instead of trial-and-error. Don't: Escalate to z-index: 9999 to force a child above another branch — it can't beat what its parent already lost to. Don't: Assume a bigger z-index always wins; it only ranks siblings inside the same stacking context.

---
