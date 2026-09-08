"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsGroup,
  settingsHref,
  settingsSectionFor,
  settingsSectionsIn,
} from "@/lib/navigation";
import { ExecutorProfilesSection } from "./executor-profiles-section";
import { FlagsSection } from "./flags-section";
import { HarnessProfilesSection } from "./harness-profiles-section";
import { IntegrationsSection } from "./integrations-section";
import { McpSection } from "./mcp-section";
import { McpServersSection } from "./mcp-servers-section";
import { ProviderIdentitySection } from "./provider-identity-section";
import { RepositoriesSection } from "./repositories-section";
import { SecretsSection } from "./secrets-section";
import { SkillsSection } from "./skills-section";
import { StatusBarSection } from "./status-bar-section";
import { WorkspaceSection } from "./workspace-section";

/**
 * Settings: **one group at a time**, chosen from the address.
 *
 * This page used to be all nine sections stacked into a single column — roughly three thousand
 * lines of forms in one scroll, with a sidebar that listed four of them. Finding Feature flags
 * meant scrolling past every MCP token, executor and integration in the Workspace, and the two
 * sections the command palette links to were not in the navigation at all. Length was not the
 * only problem: a page with no structure gives a reader nowhere to *be*, so every visit starts
 * from the top and re-reads everything.
 *
 * So the unit on screen is a **group** (`SETTINGS_GROUPS`), not a section. A group is one screen
 * of related decisions in the order they are made — a Secret, the Harness Profile that spends it,
 * the Executor it runs on — which keeps the sequence the old single column was arranged to show
 * while dropping the eight unrelated cards between you and the one you came for.
 *
 * Which group is a fact about the **URL** (`?section=`), never about component state: a settings
 * page you cannot link a colleague to is a page you explain over chat instead. `?section=` and
 * not `#secrets` because Next's router changes a hash with `history.pushState`, which fires no
 * event — the palette navigating from one settings section to another would have moved the
 * address bar and nothing else. Old `#hash` links still land correctly; see the effect below.
 *
 * Every section keeps its own `<section id="…">` heading (see `settings-shell.tsx`), so nothing
 * here repeats what the section beneath it already says. That is also what makes the anchors real:
 * within a group the id is a genuine fragment to scroll to.
 *
 * The two-column arrangement each section takes on a wide screen used to be described *here*, as
 * ten `[&>div>[data-slot=card]]` selectors reaching down into markup this file cannot see. It
 * belongs to the section, and `SettingsSection` owns it now.
 */
export function Settings() {
  const params = useSearchParams();
  const router = useRouter();
  const active = settingsSectionFor(params.get("section"));
  const group = active.group;
  const sections = settingsSectionsIn(group);

  /**
   * `/settings#secrets` was the address for months. Adopt it once, on mount, and rewrite it —
   * `replace` rather than `push` so the back button does not bounce between the two spellings of
   * one page.
   */
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || params.get("section")) return;
    adopted.current = true;
    const legacy = window.location.hash.replace(/^#/, "");
    if (legacy && SETTINGS_SECTIONS.some((s) => s.id === legacy)) {
      router.replace(settingsHref(legacy), { scroll: false });
    }
  }, [params, router]);

  /**
   * Scroll to the chosen section when it is not the one the group opens on.
   *
   * Only then: scrolling on arrival at the top of a group would fight the reader for the first
   * paint of every visit, and the card is already the first thing on screen.
   *
   * **Why this re-aligns instead of scrolling once.** It used to be a single `scrollIntoView` in
   * an effect, and it landed on the wrong section every time. The effect runs when the *route*
   * settles, which is long before the tRPC lists above the target have come back; every list that
   * resolves afterwards makes its own card taller and pushes the target further down the page
   * under the reader. Measured on `?section=skills`: the page scrolled to 1458px and `#skills`
   * ended up 1016px below the top of the viewport — the screen showed Executor profiles while the
   * navigator highlighted Skills. Since those are the hrefs the navigator, the palette and every
   * shared link use, the one affordance this page was rewritten to provide was the one that lied.
   *
   * So: align now, then keep aligning while the surface is still growing, and stop. A
   * `ResizeObserver` on the scroll container reports every one of those late expansions, and the
   * window closes on its own so nothing fights a reader who scrolls away. `behavior: "auto"`,
   * because a smooth animation restarted on each arriving query is a page that slides for a
   * second and a half.
   */
  const opensOn = sections[0]?.id;
  useEffect(() => {
    if (opensOn === active.id) return;
    const align = () =>
      document.getElementById(active.id)?.scrollIntoView({ behavior: "auto", block: "start" });
    align();

    const container = document.getElementById(active.id)?.closest("main");
    if (!container) return;
    const observer = new ResizeObserver(align);
    observer.observe(container);
    for (const child of container.querySelectorAll("section[id]")) observer.observe(child);
    // Long enough for the slowest list on the page to land, short enough that it can never be
    // mistaken for the page fighting the reader.
    const stop = window.setTimeout(() => observer.disconnect(), 1500);
    return () => {
      observer.disconnect();
      window.clearTimeout(stop);
    };
  }, [active.id, opensOn]);

  return (
    <div className={PAGE_WIDTH}>
      {/*
        No eyebrow. "SETTINGS" sat above the group name in 11px uppercase, and it was saying
        something the breadcrumb, the activity rail and the sidebar all already say — the heading
        carries its own weight. Dropping it also lets the group name take the Headline step
        (`text-xl`, 18px here) instead of `text-lg`, which resolves to 16px in this theme and was
        therefore exactly the size of the card titles beneath it. The page's own title and its
        twelve section titles being the same size is why the header read as a stutter.
      */}
      <header className="space-y-1.5">
        <h1 className="font-semibold text-xl tracking-[-0.01em]">{group}</h1>
        <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
          {captionFor(group)}
        </p>
      </header>

      {/*
        The section picker, for the widths where the sidebar is not there.

        The navigator holds the real navigation, and it is `hidden md:flex` — so below that
        breakpoint the old page had a scroll and this one would have had nothing at all. One
        control rather than a duplicate of the sidebar: a second full nav on a narrow screen is
        the sidebar again, badly.
      */}
      <Select
        value={active.id}
        onValueChange={(id) => router.push(settingsHref(id), { scroll: false })}
      >
        <SelectTrigger className="w-full md:hidden" aria-label="Settings section">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SETTINGS_GROUPS.map(({ name }) => (
            <SelectGroup key={name}>
              <SelectLabel>{name}</SelectLabel>
              {settingsSectionsIn(name).map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      <div className="space-y-5">
        {sections.map((section) => (
          <div key={section.id}>{SECTION_COMPONENTS[section.id]?.()}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * How wide the column is allowed to get, and why it is two numbers rather than one.
 *
 * Measured: at 1280 the old fixed `max-w-3xl` column filled 78% of the area beside the sidebar,
 * which reads as a page. At 1920 it filled **47%** — a 768px form marooned in 1622px with 427
 * pixels of nothing down each side, which reads as a page that failed to load.
 *
 * Widening it unconditionally would be the opposite mistake: a text input stretched to 1500px is
 * harder to use than a narrow one, and prose past about 90 characters stops being readable. So the
 * column only grows where there is space to grow into, and what it does with that space is turn
 * each section into a description column and a control column — see `SettingsSection`. No input
 * gets wider; the page stops being a ribbon down the middle.
 */
const PAGE_WIDTH = "mx-auto w-full max-w-3xl 2xl:max-w-6xl space-y-5 px-6 py-6";

function captionFor(group: SettingsGroup): string {
  return SETTINGS_GROUPS.find((g) => g.name === group)?.caption ?? "";
}

/**
 * Section id → the component that renders it.
 *
 * A lookup rather than a `component` field on the registry itself: `lib/navigation.ts` is imported
 * by the shell, and putting these there would drag every settings form into the bundle of every
 * page that draws a sidebar.
 */
const SECTION_COMPONENTS: Record<string, () => React.ReactNode> = {
  workspace: () => <WorkspaceSection />,
  integrations: () => <IntegrationsSection />,
  repositories: () => <RepositoriesSection />,
  "provider-identity": () => <ProviderIdentitySection />,
  secrets: () => <SecretsSection />,
  "agent-profiles": () => <HarnessProfilesSection />,
  "executor-profiles": () => <ExecutorProfilesSection />,
  "mcp-servers": () => <McpServersSection />,
  skills: () => <SkillsSection />,
  mcp: () => <McpSection />,
  "status-bar": () => <StatusBarSection />,
  flags: () => <FlagsSection />,
};
