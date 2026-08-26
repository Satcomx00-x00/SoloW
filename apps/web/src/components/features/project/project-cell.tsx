"use client";

import type { ProjectFieldDto, ProjectFieldValue } from "@gatecontrol/contracts";
import { Check, ChevronDown, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One cell of the project table, editable where the provider says it can be (spec F23 FR-4).
 *
 * Its own file because a cell is now four controls rather than a string: a searchable single
 * select, a typed input, a date and a set of people. Keeping them inside the table meant every
 * change to an editor touched the file that also decides hierarchy, grouping and windowing.
 *
 * Two rules hold across all of them:
 *
 *  - **A read-only field is a value with a sentence, never a disabled input.** The sentence is
 *    the provider's own ("GitLab weights need a paid tier"), which a person can act on where a
 *    greyed box is just a dead end (FR-5).
 * A cell is a fragment of a table, not a standalone widget: it carries no `TooltipProvider` of
 * its own because `ProjectTable` supplies one for the whole table. A provider per cell is a cost
 * a thousand-row table pays a thousand times over for a marker almost no cell shows (NFR-1).
 *
 * **Neutral, by decision.** GitHub paints a single-select token in the option's own colour and
 * this build renders every one of them in the theme's greys instead. The cost is real and was
 * accepted knowingly: a status column is slower to scan without hue, so the *shape* has to carry
 * more — the token anatomy below (outline, tint, 20px pill) is what keeps a set value visually
 * distinct from an empty one when colour no longer does it.
 *
 *  - **What is on screen is what the provider holds.** An edit is sent, and the value re-renders
 *    when the provider's answer comes back — never optimistically. A cell that showed the typed
 *    value first would show the operator their own input as though it were saved (NFR-7).
 */

export interface CellProps {
  field: ProjectFieldDto;
  value: ProjectFieldValue | undefined;
  /** For the accessible name — a table of forty "Status" controls is a table nobody can navigate. */
  rowTitle: string;
  onEdit?: ((value: ProjectFieldValue | null) => void) | undefined;
  pending?: boolean;
}

/**
 * The same props with the editor present.
 *
 * Spelled out rather than `Required<CellProps>`: `onEdit` is declared as `fn | undefined`, and
 * `Required` only removes the optional marker, not the undefined in the union — so the callbacks
 * below stayed possibly-undefined and every call site had to guard something already guaranteed.
 */
/**
 * The measured token recipe (GitHub Projects §2): 20px tall, 6px of side padding, 12px semibold,
 * a 1px border and a fully round radius. Never filled — outline plus a faint tint, so a dense
 * column of them reads as text with edges rather than as a wall of blocks.
 */
const TOKEN =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 font-semibold text-xs";

type EditableCellProps = Omit<CellProps, "onEdit" | "pending"> & {
  onEdit: (value: ProjectFieldValue | null) => void;
  pending: boolean;
};

/** The provider's option, if the value names one it still has. */
function optionOf(field: ProjectFieldDto, value: ProjectFieldValue | undefined) {
  if (value?.type !== "single_select") return undefined;
  return field.options.find((o) => o.id === value.optionId);
}

export function formatCellValue(
  value: ProjectFieldValue | undefined,
  field: ProjectFieldDto,
): string {
  if (!value) return "";
  switch (value.type) {
    case "text":
      return value.text;
    case "number":
      return String(value.number);
    case "date":
      return value.date;
    case "url":
      return value.url;
    case "single_select":
      return field.options.find((o) => o.id === value.optionId)?.name ?? value.optionId;
    case "iteration":
      return field.iterations.find((i) => i.id === value.iterationId)?.title ?? value.iterationId;
    case "user":
      return value.users.map((u) => u.login).join(", ");
    default:
      return "";
  }
}

/**
 * People (§7): a 20px avatar and the login for one, stacked avatars for several.
 *
 * The login is spelled out in the single-assignee case and dropped when they stack, which is the
 * reference's own rule and the right one: one name is the answer to "who holds this", and four
 * names is a paragraph in a 200px cell. The stacked avatars keep their names in tooltips.
 */
function UserCell({ value }: { value: Extract<ProjectFieldValue, { type: "user" }> }) {
  if (value.users.length === 0) return <Empty />;

  const [only] = value.users;
  if (value.users.length === 1 && only) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Face user={only} />
        <span className="min-w-0 truncate text-xs">{only.login}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center -space-x-1.5">
      {value.users.slice(0, 4).map((u) => (
        <Face key={u.login} user={u} />
      ))}
      {value.users.length > 4 && (
        // Counted, never dropped: a cell that showed four of nine assignees without saying so
        // would be a wrong answer to "who is on this".
        <span className={cn(TOKEN, "ml-2.5 border-border bg-muted/60 text-muted-foreground")}>
          +{value.users.length - 4}
        </span>
      )}
    </span>
  );
}

/** One 20px face, named in a tooltip because a circle answers nobody's question on its own. */
function Face({
  user,
}: {
  user: { login: string; name: string | null; avatarUrl: string | null };
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar className="size-5 shrink-0 border border-background">
          {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
          <AvatarFallback className="text-[9px] uppercase">{user.login.slice(0, 2)}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>{user.name ? `${user.name} (${user.login})` : user.login}</TooltipContent>
    </Tooltip>
  );
}

/** An empty cell that says so. "Nothing is set" is an answer somebody came for. */
function Empty() {
  return <span className="text-muted-foreground/40">—</span>;
}

/**
 * A single select, searchable.
 *
 * A `Command` inside a `Popover` rather than a native `<select>`: a Status field with thirty
 * options is normal on a real project, and thirty options in a native dropdown is a scroll, not a
 * choice. Clearing is its own row rather than an empty first option, because "no status" is a
 * decision and should read like one.
 */
function SelectCell({ field, value, rowTitle, onEdit, pending }: EditableCellProps) {
  const [open, setOpen] = useState(false);
  const option = optionOf(field, value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`${field.name} for ${rowTitle}`}
          disabled={pending}
          className={cn(
            TOKEN,
            "w-fit max-w-full justify-between hover:bg-accent/50 disabled:opacity-50",
            option
              ? "border-border bg-muted/60 text-foreground"
              : "border-dashed border-border bg-transparent font-normal text-muted-foreground/60",
          )}
        >
          <span className="min-w-0 truncate">{option?.name ?? "—"}</span>
          {/* `triangle-down`, per §7: a caret at the right edge is what marks a cell as editable
              before it is hovered. */}
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          {/* §8's "Select an item" heading, named after the field so a popover that has drifted
              from its cell still says which column it is about. */}
          <p className="border-b px-3 py-2 font-medium text-2xs text-muted-foreground">
            Select {field.name.toLowerCase()}
          </p>
          <CommandInput placeholder="Filter options" className="h-8" />
          <CommandList>
            <CommandEmpty>No option.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__clear"
                onSelect={() => {
                  setOpen(false);
                  onEdit(null);
                }}
              >
                <span className="text-muted-foreground">Clear</span>
                {!option && <Check className="ml-auto size-3.5" />}
              </CommandItem>
              {field.options.map((o) => (
                <CommandItem
                  key={o.id}
                  value={o.name}
                  onSelect={() => {
                    setOpen(false);
                    onEdit({ type: "single_select", optionId: o.id });
                  }}
                >
                  {/* The option dot of §8. Neutral like everything else here, so it marks
                      "this is a choice in a set" rather than encoding which one. */}
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                  />
                  <span className="truncate">{o.name}</span>
                  {option?.id === o.id && <Check className="ml-auto size-3.5" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The same shape for an iteration: a named range the provider owns, chosen from its list. */
function IterationCell({ field, value, rowTitle, onEdit, pending }: EditableCellProps) {
  const [open, setOpen] = useState(false);
  const current =
    value?.type === "iteration"
      ? field.iterations.find((i) => i.id === value.iterationId)
      : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`${field.name} for ${rowTitle}`}
          disabled={pending}
          className={cn(
            TOKEN,
            "w-fit max-w-full justify-between hover:bg-accent/50 disabled:opacity-50",
            current
              ? "border-border bg-muted/60 text-foreground"
              : "border-dashed border-border bg-transparent font-normal text-muted-foreground/60",
          )}
        >
          <span className="min-w-0 truncate">{current?.title ?? "—"}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <p className="border-b px-3 py-2 font-medium text-2xs text-muted-foreground">
            Select {field.name.toLowerCase()}
          </p>
          <CommandInput placeholder="Filter options" className="h-8" />
          <CommandList>
            <CommandEmpty>This project has no iterations.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__clear"
                onSelect={() => {
                  setOpen(false);
                  onEdit(null);
                }}
              >
                <span className="text-muted-foreground">Clear</span>
              </CommandItem>
              {field.iterations.map((i) => (
                <CommandItem
                  key={i.id}
                  value={i.title}
                  onSelect={() => {
                    setOpen(false);
                    onEdit({ type: "iteration", iterationId: i.id });
                  }}
                >
                  <span className="truncate">{i.title}</span>
                  {/* The dates, because two iterations called "Sprint 4" a year apart are the
                      normal case on a long project. */}
                  <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground">
                    {i.startDate.slice(5)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Text, number, date and url — a typed input that commits on blur or Enter.
 *
 * Committing on blur rather than on every keystroke: each commit is a provider round trip, and
 * one per character would spend a rate limit writing prefixes of a word. Escape restores what the
 * provider holds, which is the only value this component ever treats as true.
 */
function InputCell({ field, value, rowTitle, onEdit, pending }: EditableCellProps) {
  const stored = formatCellValue(value, field);
  const [draft, setDraft] = useState(stored);
  // The provider's answer wins over a draft the moment it arrives — including when another
  // client changed it, which is the case a local copy would silently paper over.
  useEffect(() => setDraft(stored), [stored]);

  const commit = () => {
    if (draft === stored) return;
    if (draft === "") {
      onEdit(null);
      return;
    }
    switch (field.type) {
      case "number": {
        const parsed = Number(draft);
        // A cell that cannot be a number is not sent. Refusing here keeps the provider's own
        // error out of a place where it would read as "the save is broken".
        if (Number.isNaN(parsed)) {
          setDraft(stored);
          return;
        }
        onEdit({ type: "number", number: parsed });
        return;
      }
      case "date":
        onEdit({ type: "date", date: draft });
        return;
      case "url":
        onEdit({ type: "url", url: draft });
        return;
      default:
        onEdit({ type: "text", text: draft });
    }
  };

  return (
    <Input
      aria-label={`${field.name} for ${rowTitle}`}
      disabled={pending}
      value={draft}
      type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(stored);
          event.currentTarget.blur();
        }
      }}
      className={cn(
        "h-6 border-transparent bg-transparent px-1 text-xs shadow-none hover:border-input focus-visible:border-input",
        // §7: a number column is read as a column of magnitudes, and magnitudes line up on the
        // right. Left-aligned, "9" and "1000" start in the same place and compare wrongly.
        field.type === "number" && "text-right tabular-nums",
      )}
    />
  );
}

export function ProjectCell({ field, value, rowTitle, onEdit, pending = false }: CellProps) {
  if (field.readOnly && field.readOnlyReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/*
           * `flex w-full min-w-0`, not `inline-flex`: an inline-flex box has no width of its own
           * to shrink from — it sizes to its content (here, GitHub's built-in "Title" field can
           * hold a whole sentence) and a table cell's `overflow: visible` lets that spill straight
           * across the columns to its right rather than clipping. `flex w-full` makes the span
           * fill the cell instead, and `min-w-0` on it and on the text span below is what then
           * lets `truncate` actually have a bound to clip against — omitted, the default flex
           * item minimum width is its content's own width, and `truncate` never gets to act.
           */}
          <span className="flex w-full min-w-0 items-center gap-1 text-muted-foreground/60">
            <Lock aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{formatCellValue(value, field) || "—"}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{field.readOnlyReason}</TooltipContent>
      </Tooltip>
    );
  }

  // Assignees are the provider's, and this table does not author them (F23 FR-8). The side panel
  // is where they are changed, through the provider — a cell that let you drag someone onto a row
  // would be editing a copy.
  if (value?.type === "user") return <UserCell value={value} />;

  if (onEdit) {
    const props = { field, value, rowTitle, onEdit, pending };
    if (field.type === "single_select") return <SelectCell {...props} />;
    if (field.type === "iteration") return <IterationCell {...props} />;
    if (field.type === "user") return <Empty />;
    return <InputCell {...props} />;
  }

  const option = optionOf(field, value);
  if (option) {
    return (
      <span className={cn(TOKEN, "max-w-full border-border bg-muted/60 text-foreground")}>
        <span className="truncate">{option.name}</span>
      </span>
    );
  }
  const text = formatCellValue(value, field);
  if (!text) return <Empty />;
  return (
    <span
      className={cn("block truncate text-xs", field.type === "number" && "text-right tabular-nums")}
    >
      {text}
    </span>
  );
}
