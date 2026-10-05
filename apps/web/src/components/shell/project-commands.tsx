"use client";

import { CommandGroup, CommandItem } from "@/components/ui/command";
import { PROJECT_SECTIONS, projectSectionHref } from "@/lib/navigation";

/*
 * The palette's Project rows, apart from the palette.
 *
 * The palette's static destinations come from the command registry and nowhere else
 * (`command-palette.contract.test.ts`). Projects are not that kind of thing — they are rows the
 * server holds, like the Tasks and Issues it searches — so they are drawn here, from data, and the
 * palette itself still names no destination of its own.
 */

/** The Projects whose title contains the query, case-insensitively; all of them for no query. */
export function matchProjects<P extends { title: string }>(
  projects: readonly P[],
  query: string,
): P[] {
  const needle = query.trim().toLowerCase();
  return needle ? projects.filter((p) => p.title.toLowerCase().includes(needle)) : [...projects];
}

/**
 * Projects as destinations — the palette's half of "pick a Project", which the sidebar does by
 * listing them.
 *
 * Browsing, one row per Project, to its overview: there is a row per section in the sidebar
 * already, and three per Project here would bury the commands above. Searching, a row per
 * section of each match, so "toDeb" Enter-able straight to its board is two keystrokes and an
 * arrow, not a click and then another.
 */
export function ProjectCommands({
  projects,
  searching,
  onSelect,
}: {
  projects: readonly { id: string; title: string }[];
  searching: boolean;
  onSelect: (href: string) => void;
}) {
  if (projects.length === 0) return null;
  const sections = searching ? PROJECT_SECTIONS : PROJECT_SECTIONS.filter((s) => s.path === "");
  return (
    <CommandGroup heading="Projects">
      {projects.flatMap((project) =>
        sections.map((section) => {
          const href = projectSectionHref(project.id, section.path);
          return (
            <CommandItem key={href} value={href} onSelect={() => onSelect(href)}>
              <section.icon className="shrink-0 text-muted-foreground" strokeWidth={2.25} />
              <span className="min-w-0 flex-1 truncate">
                {project.title}
                {searching && <span className="text-muted-foreground"> › {section.label}</span>}
              </span>
            </CommandItem>
          );
        }),
      )}
    </CommandGroup>
  );
}
