---
target: the settings page
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/debian/GateControl/apps/web/src/components/features/settings/settings.tsx"
target_fingerprint: "sha256:6bc05c927a9614ccfab89c3da5074728aaf1268af7e1ad5c899c7b8abfa1311c"
target_path: /home/debian/GateControl/apps/web/src/components/features/settings/settings.tsx
timestamp: 2026-09-08T06-42-19Z
slug: web-src-components-features-settings-settings-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence)

Surface mode: **Operate**. Measured on the running build at 1600x900 and 900x820, dark theme, real seeded data (7 repositories, 3 secrets, 1 harness profile, 1 executor, 5 flags).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | `?section=skills` leaves the target 1016px below the fold while the navigator highlights "Skills"; 11 of 12 sections have no loading state, so empty and loading are indistinguishable |
| 2 | Match System / Real World | 2 | Raw enum values on screen: `scm_pat`, `subscription_token`, `local_path`, `ff-core-program`; a placeholder reads "Select a scm_pat secret" |
| 3 | User Control and Freedom | 2 | A connected Repository and an Executor profile can never be deleted — no delete path exists in either file |
| 4 | Consistency and Standards | 2 | 3 of 12 card titles disagree with their navigator labels; two contradictory "create a thing" patterns inside one group |
| 5 | Error Prevention | 1 | New Harness Profiles default to `bypassPermissions` ("Never ask"), and the list badges the *cautious* profiles amber while leaving permissive ones unmarked |
| 6 | Recognition Rather Than Recall | 3 | Navigator lists all 12 sections with icon, label and caption; `?section=` makes location linkable. Disabled destructive buttons carry no reason |
| 7 | Flexibility and Efficiency | 2 | 19 tab stops before the first control in `main`, no skip link; no bulk actions (7 repositories configured one at a time) |
| 8 | Aesthetic and Minimalist | 2 | The 288px descriptor rail is empty for ~82% of the Harnesses group's 2,325px height; the same secrets warning repeats 7x in one card |
| 9 | Error Recovery | 2 | ~15 sites print `{error.message}` verbatim; `library-ui.tsx:43` renders a raw server string in 12px muted monospace as the whole recovery story |
| 10 | Help and Documentation | 3 | Excellent inline consequence-copy; nothing explains the order decisions are made in |
| **Total** | | **21/40** | **Acceptable (low) — significant improvements needed** |

## Design Specificity Verdict

**The prose is authored for this product. The composition is not.**

The copy is unmistakably SoloW's. `harness-profiles-section.tsx:79-102` describes permission modes by their consequence in a headless run. `flags-section.tsx:89` admits there is no in-app undo and hands over the shell command. `describeUsage` refuses the lazy total and says "3 tasks, 1 workflow step" instead of "4 things". No competitor could ship those sentences unchanged.

The layout is a stock shadcn settings scaffold — Card → CardHeader/CardTitle/CardDescription → permanently-open create form → `ul.divide-y` — instantiated twelve times with zero variation for what the section governs. A Secret (irreversible, credential-bearing) is laid out identically to the Status bar (reversible, cosmetic). Any SaaS could ship this skeleton and only the sentences would give it away.

Two structural inversions make it worse than generic:

1. **Creation outranks inventory.** Every section opens with an empty form and a filled primary button; the things you already own are demoted to a thin list below it. You land on Secrets and the loudest object is a blank "Save secret" for a secret that does not exist, while your three real credentials sit underneath in 13px rows.
2. **There is no state anywhere.** DESIGN.md exists, in its own words, so "a reader who looks up from their editor should be able to tell whether anything is waiting on them" — and Settings, which configures machinery that runs unattended, shows nothing about what is running. A concurrency cap is a number in a form, never "2 of 3 running".

**Deterministic scan.** The CLI detector returned **0 findings** across all ~7,100 lines of settings source (confirmed with `--no-config`). The in-page detector, injected live, returned **70 findings across the five panes**: `line-length` 35, `nested-cards` 21, `buried-raster` 5, `flat-type-hierarchy` 4, `tiny-text` 4, `skipped-heading` 1. The `skipped-heading` (h1 "Interface" → h3 "Left", `status-bar-section.tsx:66`) independently corroborates the heading-structure failure below. `buried-raster` is the app-wide grain overlay at 0.028 and is intentional — a false positive here. `flat-type-hierarchy` is not: h1 and card titles both measure 16px, a 1.14:1 largest step.

**Visual overlays.** Injection succeeded on five panes and the overlay ran in the page, but the browser it ran in has since been shut down, so there is no overlay for you to look at now. Screenshots were captured instead.

## Overall Impression

The information architecture is already good and was clearly fought for — one registry, URL-addressable groups, a documented rationale for the column widths. The writing is better than most products manage. What is failing is everything between those two: the surface has no compositional idea of its own, it puts the empty form above the real inventory on every single screen, it spends a 288px column on nothing, and its one use of colour points at the safe rows instead of the dangerous ones. You are right that it needs a visual refactor. You are wrong that there is nothing here worth keeping — the registry and the copy are the foundation the refactor should be built on.

## What's Working

1. **The single navigation registry with `?section=` as source of truth.** `lib/navigation.ts:231-311` is one list read by both the navigator and the page. Sections are linkable, palette-reachable and back-button-correct, and `settingsSectionFor` tolerates a stale `#hash` bookmark rather than erroring. This is why the surface scales to 12 sections at all.
2. **Consequence copy instead of definition copy.** The interface tells you what a setting *does to you*, not what it is called.
3. **Usage is named, never counted.** "Used by gitlab", "3 tasks, 1 workflow step", "82 past sessions" worded as history so it cannot read as 82 live runs.

## Priority Issues

### [P0] The section deep link lands on the wrong section
Navigating to `?section=skills` scrolls to 1458px while `#skills` is still 1016px below the viewport top — measured, stable after 2.5s. The screen shows Executor profiles; the navigator highlights Skills. Same failure for any section not first in its group. These are the hrefs the navigator, the palette and every shared link use — the exact affordance the page was rewritten to provide. **Fix:** `settings.tsx:89-93` fires `scrollIntoView` once, before the async tRPC lists have expanded the cards above the target. Re-run on target-offset change (ResizeObserver, or retry until the rect stabilises) and drop `behavior:"smooth"` for the initial landing.
*Anchor:* `settings.tsx:89-93` · **/impeccable harden**

### [P1] Creation is louder than inventory on every screen
Each section opens with a permanently-expanded create form carrying a filled primary button, above a `divide-y` list of what exists. Four filled primary buttons compete in the Harnesses group alone, against DESIGN.md's "there is rarely more than one". The Harnesses group is 2,325px of scroll with 47 interactive controls and 5 unrelated forms all open at once. Six of eight cognitive-load checks fail (single focus, chunking, hierarchy, one-thing-at-a-time, minimal choices, working memory). **Fix:** invert it. The list of what you have is the section; creating is one secondary action that opens a form. Two of the twelve sections (MCP servers, Skills) already do exactly this, in the same group as three that do not.
*Anchor:* `secrets-section.tsx`, `harness-profiles-section.tsx`, `executor-profiles-section.tsx` · **/impeccable distill**

### [P1] The default permission mode is the most permissive one, and the colour points the wrong way
`DEFAULT_HARNESS_PERMISSION_MODE = "bypassPermissions"`, so a new Harness Profile arrives set to "Never ask". In the list, only the *exception* is badged: "read only" and "asks first" get an amber `state-review` badge and "Never ask" gets no marker at all. The mode is changeable in place with one unconfirmed click, while deleting the same profile is confirmed. This contradicts PRODUCT.md Principle 4 and constraint C-5. **Fix:** mark "Never ask" explicitly with the destructive token and its own glyph; confirm any in-place change that increases permission; state the reason for the default at the field.
*Anchor:* `harness-profiles-section.tsx:688-695`, `:701-721` · **/impeccable harden**

### [P1] No heading structure and no bypass mechanism — the recorded WCAG 2.2 AA bar is not met
`main` on the Harnesses group contains exactly one heading. "Secrets", "Harness profiles", "Executor profiles", "MCP servers" and "Skills" are all `div`s, because `CardTitle` renders a div (`ui/card.tsx:31-38`). There are 19 tab stops before the first control in `main` and no skip link. WCAG 2.4.1 is satisfied by either a skip link or heading structure; this surface has neither. The in-page detector separately flagged an h1→h3 jump in the Interface group. **Fix:** give `CardTitle` an `asChild`/`as` escape and render every settings section title as `h2`; add a skip-to-content link targeting `main`.
*Anchor:* `ui/card.tsx:31-38`, `status-bar-section.tsx:66` · **/impeccable harden**

### [P2] The wide layout parks emptiness beside a scroll
At 1600px the descriptor rail is 288px and the control column 774px. Across the Harnesses group the rail carries content for ~420 of 2,325 vertical pixels — empty for ~82% of the height — while the form beside it scrolls 2.8 screens. The old fixed column "read as a page that failed to load"; the replacement inverted the problem rather than solving it. **Fix:** make the rail sticky within its card so the section name stays with the field being edited, and let the control column pair genuinely-paired fields at 2xl (Auth mode / Concurrency cap, Model / Mode).
*Anchor:* `settings.tsx:183-194` · **/impeccable layout**

### [P2] Three citable departures from DESIGN.md
- **Three Families Rule broken in 16 places.** Task-lifecycle tokens used for non-lifecycle facts: `state-ready`/`state-failed` for probe results, `state-review` for permission mode, `state-done` for save confirmations, `state-failed` for error text. Retuning Review amber today would silently restyle every permission badge in Settings.
- **Raw vendor palette.** `setup-file-rows.tsx:68` uses `border-amber-500/40 bg-amber-500/5` — Tailwind's own palette at chroma 0.188, not a project token. The only such instance in the folder.
- **Fifth control height.** The MCP client-config tabs measure 25px, off the 24/28/32/36 ladder.
**Fix:** introduce `--feedback-ok` / `--feedback-error` / `--feedback-caution` (they may start at the same values) and point Settings at those; replace `amber-500`; move the tabs onto the ladder.
*Anchor:* `harness-profiles-section.tsx:691`, `setup-file-rows.tsx:68` · **/impeccable colorize**

### [P2] Two ways to add a repository, zero ways to remove one
Inside the same Connections group, Integrations offers "Import a repository" and Repositories offers "Connect repository". Both produce a Repository; neither can undo it. The Repositories card measures 2,827px because each of 7 repositories repeats the *identical* two-line amber secrets warning — 7 copies of one warning in one card, which is banner blindness by construction. **Fix:** one "Add a repository" flow with source as the first choice; hoist the warning to card level, stated once; collapse each repository's setup-files block behind its row; add a confirmed Disconnect.
*Anchor:* `repositories-section.tsx:399`, `setup-file-rows.tsx:68-71` · **/impeccable distill**

## Persona Red Flags

**Alex (Power User)** — deep links are the one accelerator and they are broken. No bulk anything: 7 repositories means 7 separate saves, with no way to apply `.env` to all of them. Executor profiles are selected for editing by clicking a **badge** with no button affordance, no "Edit" label and no delete.

**Sam (Accessibility-Dependent)** — hard fails. 19 tab stops to the first control, no skip link, zero `h2`s across a 2,325px group: both bypass mechanisms absent. Every disabled trash trigger is unreachable by keyboard and carries no `title`, so the reason is undiscoverable. Four select placeholders measure 4.01–4.11:1 against a 4.5:1 requirement. Credit where due: the focus ring is correct and singular (3.78:1 on card), `role="alert"`/`role="status"` are used consistently, the confirm dialog has proper `alertdialog` semantics, and Chrome's own a11y tree shows **zero** focusable elements with an empty accessible name.

**Riley (Stress Tester)** — 11 of 12 sections have no loading state. `flags-section.tsx:54` renders nothing at all if the list is empty — a card with a title and a void. `mcp-section.tsx:244` binds `loading={revoke.isPending}` unscoped, so revoking one token spins every Revoke button, while its neighbours scope it correctly by id. `workspace-section.tsx:41` calls `window.location.reload()` on a successful rename, destroying any unsaved edit elsewhere in the group. Revoked MCP tokens are filtered out entirely, so there is no record a token ever existed — an auditing gap in a product whose pitch is "own your data".

**The solo developer running harnesses locally** (from PRODUCT.md) — came here because a run stalled. Nothing on this surface says which profile is running now, how many of its `cap 3` slots are occupied, or whether anything is Parked on quota. His new profile defaults to "Never ask" and the amber badges land on his *safe* profiles. He can add a repository two ways and remove it zero ways, on a machine he owns. And his own vocabulary leaks: the URL says `?section=agent-profiles` for "Harness profiles", the card says "MCP" where the nav says "MCP access", the card says "Executor profiles" where the nav says "Executors".

## Minor Observations

- **The header stutters.** `h1 "Workspace"` at 16px/600 sits directly above `CardTitle "Workspace"` at 16px/600. Identical word, identical type. The mechanical cause: `settings.tsx:99` uses `text-lg`, which resolves to 16px in this theme, so the page title and card titles are the same step. The Headline step (18px) is unreachable on this page.
- **An eyebrow above the heading.** `settings.tsx:98` renders "SETTINGS" above the group name. The craft floor bans this outright — the heading carries its own weight.
- **The eyebrow also misses the label token**: 11px/400 at 0.05em where the Label step is 11px/500 at 0.14em.
- **Two contradictory create patterns inside one group** — Secrets/Harness profiles/Executors use inline forms; MCP servers/Skills use dialogs.
- **"Initialize default labels" writes ~15 labels to a real remote repository with no confirmation** (`seed-default-labels-button.tsx:36-43`). Additive and idempotent, but it is the only unconfirmed outbound write on the page.
- **Feature flags are labelled by key** — `ff-core-program` looks identical to `ff-agent-widgets`, but one is the kill switch for the product's core loop.
- **Revoking an MCP token is one unconfirmed click**, while deleting a Secret you can simply re-paste is confirmed. The risk calculus is inverted.
- **Every destructive confirmation ends on a near-white button.** `alert-dialog.tsx:121` calls `buttonVariants()` with no variant, so "Delete secret", "Disconnect" and "Turn off the core loop" render identically to "Save secret". Alarm Red is reserved in DESIGN.md for exactly this and never reaches it.
- **Verified clean:** no horizontal overflow at 1600 or 900; `main` is the only scroll region; all badges route through the soft-badge definition; every icon carries `aria-hidden`.
- **Not a defect, but noisy:** the console logs a WebSocket reconnect error every 1-5s because the orchestrator on :5001 was not running during the assessment. Settings does not depend on it.

## Questions to Consider

1. What if a settings section could show its own live state — `2 of 3 running` instead of a number in a form? Would that turn the 288px empty rail into the most useful column on the page?
2. Why is a Secret laid out exactly like the Status bar? What would this surface look like if the layout itself encoded stakes — credentials reading as a vault, interface reading as preferences?
3. Should there be five groups, or two — "set up a run", walked once, and "everything else", a reference?
4. If `bypassPermissions` is the honest default for headless runs, why does the interface act embarrassed about it? Either it is right and the UI should say so at the field, or it is wrong and the default should change. The middle position is the only one that can surprise someone.
