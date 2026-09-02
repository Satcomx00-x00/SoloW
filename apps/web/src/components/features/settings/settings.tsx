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
import { cn } from "@/lib/utils";
import { AgentProfilesSection } from "./agent-profiles-section";
import { ExecutorProfilesSection } from "./executor-profiles-section";
import { FlagsSection } from "./flags-section";
import { IntegrationsSection } from "./integrations-section";
import { McpSection } from "./mcp-section";
import { ProviderIdentitySection } from "./provider-identity-section";
import { RepositoriesSection } from "./repositories-section";
import { SecretsSection } from "./secrets-section";
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
 * of related decisions in the order they are made — a Secret, the Agent Profile that spends it,
 * the Executor it runs on — which keeps the sequence the old single column was arranged to show
 * while dropping the eight unrelated cards between you and the one you came for.
 *
 * Which group is a fact about the **URL** (`?section=`), never about component state: a settings
 * page you cannot link a colleague to is a page you explain over chat instead. `?section=` and
 * not `#secrets` because Next's router changes a hash with `history.pushState`, which fires no
 * event — the palette navigating from one settings section to another would have moved the
 * address bar and nothing else. Old `#hash` links still land correctly; see the effect below.
 *
 * Every section keeps its own `<Card id="…">` heading, so nothing here repeats what the card
 * beneath it already says. That is also what makes the anchors real: within a group the id is a
 * genuine fragment to scroll to.
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
   */
  const opensOn = sections[0]?.id;
  useEffect(() => {
    if (opensOn === active.id) return;
    document.getElementById(active.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active.id, opensOn]);

  return (
    <div className={PAGE_WIDTH}>
      <header className="space-y-1.5">
        <p className="text-2xs text-muted-foreground uppercase tracking-wider">Settings</p>
        <h1 className="font-semibold text-lg tracking-[-0.01em]">{group}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">{captionFor(group)}</p>
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

      <div className={cn("space-y-6", WIDE_SECTION_LAYOUT)}>
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
 * pixels of nothing down each side, which reads as a page that failed to load. A single Workspace
 * card, the shortest section here, occupied about a seventh of the screen and the rest was empty.
 *
 * Widening it unconditionally would be the opposite mistake: a text input stretched to 1500px is
 * harder to use than a narrow one, and prose past about 90 characters stops being readable. So
 * the column only grows where there is genuinely space to grow into, and what it does with that
 * space is described below — it is not spent on longer lines.
 */
const PAGE_WIDTH = "mx-auto w-full max-w-3xl 2xl:max-w-6xl space-y-5 px-6 py-6";

/**
 * On a wide screen a section becomes two columns: what it is on the left, its controls on the
 * right.
 *
 * This is the shape that lets a settings page use a large screen without making anything on it
 * wider. The heading and its explanation move out of the controls' way into a fixed 18rem
 * column, and the controls keep roughly the measure they already had — 776px at 1536 and above,
 * against 720 before — so no input grows and no sentence gets longer. The page stops being a
 * narrow ribbon down the middle; nothing inside it changes size.
 *
 * Expressible in one place because every section here has the same skeleton: exactly one `Card`,
 * holding exactly one `CardHeader` and one `CardContent`. Grid auto-placement does the rest, so
 * ten sections are re-laid out without any of them learning about it — and a section added later
 * inherits it by being built the same way as its neighbours.
 *
 * `2xl`, not `xl`: at 1280 the split would take the controls down to 606px, narrower than the
 * 720 they have today, so the breakpoint is set where the trade actually pays. Below it this is
 * inert and the layout is exactly the one that measured healthy.
 *
 * Scoped `> div >` rather than by descendant: `flags-section` opens a dialog, and a dialog that
 * happened to hold a card would otherwise be re-laid out as a settings row.
 */
const WIDE_SECTION_LAYOUT = [
  "2xl:[&>div>[data-slot=card]]:grid",
  "2xl:[&>div>[data-slot=card]]:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]",
  "2xl:[&>div>[data-slot=card]]:items-start",
  "2xl:[&>div>[data-slot=card]]:gap-x-10",
].join(" ");

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
  "agent-profiles": () => <AgentProfilesSection />,
  "executor-profiles": () => <ExecutorProfilesSection />,
  mcp: () => <McpSection />,
  "status-bar": () => <StatusBarSection />,
  flags: () => <FlagsSection />,
};
