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
import { AgentProfilesSection } from "./agent-profiles-section";
import { ExecutorProfilesSection } from "./executor-profiles-section";
import { FlagsSection } from "./flags-section";
import { IntegrationsSection } from "./integrations-section";
import { McpSection } from "./mcp-section";
import { ProviderIdentitySection } from "./provider-identity-section";
import { RepositoriesSection } from "./repositories-section";
import { SecretsSection } from "./secrets-section";
import { StatusBarSection } from "./status-bar-section";

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
    <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
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

      <div className="space-y-6">
        {sections.map((section) => (
          <div key={section.id}>{SECTION_COMPONENTS[section.id]?.()}</div>
        ))}
      </div>
    </div>
  );
}

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
