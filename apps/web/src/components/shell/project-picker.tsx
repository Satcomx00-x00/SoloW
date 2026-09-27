"use client";

import { Check, ChevronsUpDown, FolderGit2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { projectSectionHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * Which Project you are in, chosen from the navigator's own title (spec F16).
 *
 * **The problem it removes.** Picking a Project used to mean traversing two columns: the rail's
 * *Projects* entry, then a hub page whose content was mostly links back out of itself, then the
 * project, and only then the section you actually wanted. And once inside, a second switcher sat
 * just below the title — a `Select` that repeated, in a smaller font, the name the title already
 * said. Two controls for one fact, neither of them where you were looking.
 *
 * So the title *is* the control. It says where you are and it is what you press to be somewhere
 * else, which is the arrangement every editor with a workspace switcher has converged on, and it
 * is reachable from every screen rather than only from inside a Project.
 *
 * **It still navigates.** Pressing a Project pushes a URL; nothing is held in a store. That is
 * the rule `projectIdFromPath` was written for — a reload, a shared link and the back button all
 * land on the same Project, where an in-memory selection would silently reset to "some project"
 * on every refresh.
 *
 * **Switching keeps your section.** Going from one Project's board to another lands on the
 * second Project's board, not its overview, which is what someone comparing two boards actually
 * wants. That behaviour came from the `Select` this replaces and is the one thing worth keeping
 * from it.
 *
 * A `Popover` + `Command`, not a `Select`: the list is searchable (a Workspace can hold dozens),
 * it carries a second kind of row — creating a Project — that a `Select` has nowhere to put, and
 * it avoids the hidden native `<select>` that `e2e/core-program/shell.spec.ts` exists because of.
 */
export function ProjectPicker({
  projectId,
  title,
  caption,
  /** The section inside the current Project, so switching stays on it. "" is the overview. */
  section,
}: {
  projectId: string | null;
  title: string;
  caption: string;
  section: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Only asked for once the picker is opened: every screen in the app renders this title, and a
  // list nobody has asked to see is not worth a request on each of them.
  const projects = trpc.project.list.useQuery({}, { enabled: open });

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={`${title} — switch project`}
        className={cn(
          "flex h-11 w-full shrink-0 items-center gap-2 border-b px-3 text-left transition-colors",
          "hover:bg-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          open && "bg-sidebar-accent/60",
        )}
        type="button"
      >
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate font-semibold text-sm leading-tight">{title}</span>
          <span className="truncate text-muted-foreground text-xs leading-tight">{caption}</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      {/* Aligned to the trigger and matched to the sidebar's width, so the list opens over the
          column it belongs to rather than floating across the content beside it. */}
      <PopoverContent align="start" className="w-60 p-0" sideOffset={0}>
        <Command>
          <CommandInput placeholder="Find a project…" />
          <CommandList>
            <CommandEmpty>No project matches.</CommandEmpty>
            <CommandGroup heading="Projects">
              {(projects.data ?? []).map((project) => (
                <CommandItem
                  key={project.id}
                  onSelect={() => go(projectSectionHref(project.id, section))}
                  // cmdk filters on this rather than on the id, so typing a name narrows the list.
                  value={project.title}
                >
                  <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {project.itemCount}
                  </span>
                  {project.id === projectId && <Check aria-hidden className="size-3.5 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              {/*
               * Creating one still happens on `/projects`, which is where both creation dialogs
               * live and where `control-check.spec.ts` presses "Create a project". Removing the
               * rail entry took away the way *in* to that page, so the picker carries it — a
               * Workspace with no Projects yet must not be a Workspace with no way to make one.
               */}
              <CommandItem onSelect={() => go("/projects")} value="__manage__">
                <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span>New or adopted project…</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
