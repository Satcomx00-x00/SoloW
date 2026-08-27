"use client";

import type { ProjectFieldDto, ProjectFieldValue } from "@solow/contracts";
import type { DerivedPriority } from "@solow/core";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
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
import {
  addMonths,
  describeSpan,
  formatDate,
  isoToday,
  monthGrid,
  monthLabel,
  monthOf,
  parseDateInput,
  WEEKDAY_HEADINGS,
} from "./date-input";

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

/**
 * One priority a repository's labels offer, ready to be drawn and written.
 *
 * `label` is what gets written; `name` and `rank` are what `priorityFromLabel` read out of it, so
 * the menu can sort by urgency and spell each one the way the team does.
 */
export interface PriorityChoice extends DerivedPriority {
  color: string | null;
}

export interface CellProps {
  field: ProjectFieldDto;
  value: ProjectFieldValue | undefined;
  /** For the accessible name — a table of forty "Status" controls is a table nobody can navigate. */
  rowTitle: string;
  onEdit?: ((value: ProjectFieldValue | null) => void) | undefined;
  pending?: boolean;
  /**
   * What to draw in place of the em-dash when the provider holds no value.
   *
   * The one case that needs it today is a priority the project's field never received and the
   * issue's labels state anyway (`priorityFromLabels`). It is drawn *where the value would be*
   * and still inside the unset styling — dashed edge, muted — because it is not a value: nothing
   * was written to the provider, and the cell must not claim otherwise.
   */
  fallback?: React.ReactNode;
  /** For a date field that is one end of a range: the other end. See `DateCounterpart`. */
  counterpart?: DateCounterpart | undefined;
  /**
   * The day relative dates resolve against, as `YYYY-MM-DD`.
   *
   * Passed in rather than read off the clock here so a table full of date cells agrees about what
   * "today" is — and so the behaviour can be tested for a chosen day instead of the day the suite
   * happens to run on.
   */
  today?: string | undefined;
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
  "badge-soft inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 font-semibold text-xs";

type EditableCellProps = Omit<CellProps, "onEdit" | "pending"> & {
  onEdit: (value: ProjectFieldValue | null) => void;
  pending: boolean;
};

/**
 * GitHub's single-select palette, by name, in the values measured from dark dimmed (§2).
 *
 * Projects v2 stores an option's colour as a **palette name** — `GREEN`, `PURPLE` — and not as a
 * hex. Treating that string as a colour produces `#GREEN`, which is not a colour, so every token
 * silently fell back to grey and the column looked exactly as it had before the change. Nothing
 * errored; the styling simply did not apply.
 *
 * GitLab reports hex on its scoped labels, so both forms have to be accepted, which is why this
 * is a lookup with a passthrough rather than a translation everything must go through.
 */
const OPTION_PALETTE: Record<string, string> = {
  GRAY: "#9198A1",
  BLUE: "#478BE6",
  GREEN: "#57AB5A",
  YELLOW: "#C69026",
  ORANGE: "#CC6B2C",
  RED: "#E5534B",
  PINK: "#C96198",
  PURPLE: "#986EE2",
};

/** A stored option colour as something CSS will accept, or undefined when it is neither form. */
function optionColour(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const named = OPTION_PALETTE[color.toUpperCase()];
  if (named) return named;
  // GitLab's form: already a colour, with or without the hash.
  if (/^#?[0-9a-f]{3,8}$/i.test(color)) return color.startsWith("#") ? color : `#${color}`;
  // A vocabulary neither provider has taught us. Grey is the honest answer — inventing a hue for
  // an unknown name would tell the reader something the provider never said.
  return undefined;
}

/**
 * The provider's own colour for one option, handed to the shared soft badge.
 *
 * The mixing lives in `.badge-soft` (see globals.css) rather than here, so a single-select token,
 * a label and a state badge cannot drift into three slightly different softnesses.
 */
function optionTone(color: string | undefined): React.CSSProperties | undefined {
  const hex = optionColour(color);
  return hex ? ({ "--badge-color": hex } as React.CSSProperties) : undefined;
}

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
        <span className={cn(TOKEN, "ml-2.5 text-muted-foreground")}>+{value.users.length - 4}</span>
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
function SelectCell({ field, value, rowTitle, onEdit, pending, fallback }: EditableCellProps) {
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
            !option && "border-dashed font-normal text-muted-foreground/60",
          )}
          // The provider's colour wins over the neutral classes above when it reports one.
          style={optionTone(option?.color)}
        >
          <span className="min-w-0 truncate">{option?.name ?? fallback ?? "—"}</span>
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
          {/* Nothing to search when there is nothing to search through. */}
          {field.options.length > 0 && (
            <CommandInput placeholder="Filter options" className="h-8" />
          )}
          <CommandList>
            {/*
              A single-select the provider defines with *no options* is not a broken control — it
              is a field nobody has configured yet. Saying which, and where to fix it, is the
              difference between "this app is broken" and "go and add your priorities". SoloW
              cannot add them: the provider owns the field's vocabulary (Decision 0018).

              Said *outside* `CommandEmpty`, which was where it used to live and where it never
              rendered: cmdk draws its empty state in response to a search, so a field with zero
              options — the one case this sentence was written for — opened on a popover holding a
              heading and a Clear row, and no explanation at all.
            */}
            {field.options.length === 0 && (
              <p className="px-3 py-4 text-center text-2xs text-muted-foreground">
                “{field.name}” has no options yet — add them on the provider.
              </p>
            )}
            <CommandEmpty>No option matches.</CommandEmpty>
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
                  {/*
                    The option as the *token it will become*, in the provider's own colour.
                    
                    This used to be a neutral dot beside a plain name — "a choice in a set" without
                    encoding which one. It is the wrong trade here: a chosen cell shows `Ready` in
                    green and the menu it was chosen from showed grey, so the two readings of one
                    option did not match, and picking one meant reading the words rather than
                    recognising the token.
                  */}
                  <span className={cn(TOKEN, "max-w-full")} style={optionTone(o.color)}>
                    <span className="truncate">{o.name}</span>
                  </span>
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
            !current && "border-dashed font-normal text-muted-foreground/60",
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

/**
 * The other end of a range, when this cell is one end of one.
 *
 * Start and Target are two independent fields the provider owns, and this does not turn them into
 * one control: writing both from one popover is two writes, either of which can fail, and a
 * half-applied range is worse than two cells. What it does is let each end *see* the other — the
 * span, the counterpart marked in the grid, and a plain sentence when a target lands before its
 * start.
 */
export interface DateCounterpart {
  /** The other field's name, as the project spells it. */
  name: string;
  date: string | null;
  /** Which end this cell is. `end` is the one that can be before its counterpart and be wrong. */
  role: "start" | "end";
}

/** The offers worth one click. Deliberately few: a wall of chips is a menu, not a shortcut. */
const DATE_SHORTCUTS: ReadonlyArray<{ label: string; input: string }> = [
  { label: "Today", input: "today" },
  { label: "+1w", input: "+1w" },
  { label: "+1m", input: "+1m" },
  { label: "End of month", input: "eom" },
];

/**
 * A date, chosen from a calendar or typed the way people say dates.
 *
 * The native `<input type="date">` this replaces was three things at once and good at none of
 * them: its picker is the browser's, its text format is the operating system's, and on a table row
 * it renders a spinner control that is 140px wide before it holds anything. What a planning table
 * needs is the opposite — a token that reads as a date, and a picker that knows what "next friday"
 * and "+2w" mean, because that is how a date gets decided in a planning conversation.
 *
 * `today` is a prop rather than a `new Date()` inside: every relative date resolves against it, and
 * a component that read the clock itself could not be tested for the day it renders on.
 */
function DateCell({
  field,
  value,
  rowTitle,
  onEdit,
  pending,
  counterpart,
  today,
}: EditableCellProps & { counterpart?: DateCounterpart | undefined; today: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const stored = value?.type === "date" ? value.date : null;
  const [month, setMonth] = useState(() => monthOf(stored ?? today));

  // Reopening on the value's own month, not on wherever the last visit left off: a cell holding
  // a date in March should not open in September because that is where somebody else was paging.
  useEffect(() => {
    if (open) {
      setMonth(monthOf(stored ?? today));
      setTyped("");
    }
  }, [open, stored, today]);

  const commit = (iso: string | null) => {
    setOpen(false);
    onEdit(iso === null ? null : { type: "date", date: iso });
  };

  const apply = (text: string) => {
    const parsed = parseDateInput(text, today);
    // Unreadable input is refused rather than guessed at. The box keeps what was typed so it can
    // be corrected — clearing it would look like the value had been taken and thrown away.
    if (parsed) commit(parsed);
  };

  const span = stored && counterpart?.date ? describeSpan(counterpart.date, stored) : null;
  const inverted =
    stored !== null &&
    counterpart?.date != null &&
    (counterpart.role === "end" ? stored < counterpart.date : stored > counterpart.date);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${field.name} for ${rowTitle}`}
          disabled={pending}
          className={cn(
            TOKEN,
            "w-fit max-w-full justify-between gap-1.5 hover:bg-accent/50 disabled:opacity-50",
            !stored && "border-dashed font-normal text-muted-foreground/60",
          )}
        >
          <CalendarDays aria-hidden className="size-3 shrink-0 opacity-60" />
          <span className="min-w-0 truncate tabular-nums">{stored ? formatDate(stored) : "—"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="border-b px-3 py-2">
          <p className="font-medium text-2xs text-muted-foreground">
            Set {field.name.toLowerCase()}
          </p>
        </div>

        <div className="space-y-2 p-2">
          <Input
            value={typed}
            autoFocus
            // The syntax is in the placeholder rather than in a help popover nobody opens: these
            // three are the whole language, and seeing them is what teaches it.
            placeholder="2026-09-01, +2w, next friday"
            className="h-7 text-xs"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply(typed);
              }
            }}
          />

          <div className="flex flex-wrap gap-1">
            {DATE_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.input}
                type="button"
                className="rounded-md border px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground"
                onClick={() => apply(shortcut.input)}
              >
                {shortcut.label}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setMonth(monthOf(addMonths(`${month}-01`, -1)))}
            >
              <ChevronLeft aria-hidden className="size-3.5" />
            </button>
            <span className="font-medium text-xs">{monthLabel(month)}</span>
            <button
              type="button"
              aria-label="Next month"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setMonth(monthOf(addMonths(`${month}-01`, 1)))}
            >
              <ChevronRight aria-hidden className="size-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-px">
            {WEEKDAY_HEADINGS.map(({ name, initial }) => (
              <abbr
                key={name}
                title={name}
                className="py-1 text-center font-medium text-[10px] text-muted-foreground/70 no-underline"
              >
                {initial}
              </abbr>
            ))}
            {monthGrid(month)
              .flat()
              .map((day) => {
                const outside = !day.startsWith(month);
                const selected = day === stored;
                const isToday = day === today;
                const other = counterpart?.date === day;
                /* The span between the two ends, tinted rather than outlined: it is context for
                   the choice being made, and an outline would compete with the selection. */
                const between =
                  counterpart?.date != null &&
                  stored !== null &&
                  ((day > counterpart.date && day < stored) ||
                    (day > stored && day < counterpart.date));
                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={formatDate(day)}
                    aria-current={selected ? "date" : undefined}
                    onClick={() => commit(day)}
                    className={cn(
                      "rounded-md py-1 text-center text-xs tabular-nums transition-colors",
                      outside ? "text-muted-foreground/35" : "text-foreground",
                      between && "bg-accent/50",
                      isToday && !selected && "ring-1 ring-ring/40 ring-inset",
                      other && !selected && "underline decoration-dotted underline-offset-2",
                      selected
                        ? "bg-primary font-semibold text-primary-foreground"
                        : "hover:bg-accent",
                    )}
                  >
                    {Number(day.slice(8))}
                  </button>
                );
              })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-2xs">
          {/* What the other end says, and what the two of them add up to. The one number a person
              actually wants from a pair of dates is the length of the span between them. */}
          <span
            className={cn(
              "min-w-0 truncate",
              inverted ? "text-state-parked" : "text-muted-foreground",
            )}
          >
            {counterpart?.date
              ? inverted
                ? `Before ${counterpart.name.toLowerCase()} (${formatDate(counterpart.date)})`
                : `${counterpart.name}: ${formatDate(counterpart.date)}${span ? ` · ${span}` : ""}`
              : counterpart
                ? `No ${counterpart.name.toLowerCase()} set`
                : ""}
          </span>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => commit(null)}
          >
            Clear
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A priority carried by a **label**, chosen from the labels the repositories actually define.
 *
 * Why this exists at all: a GitHub project routinely ships a `Priority` single-select with no
 * options configured, and the team writes `prio/p2` on the issue instead. The ordinary select then
 * opens on an empty list and says "add them on the provider" — true, and useless to somebody whose
 * priorities are right there on every issue. GitLab has never had this problem, because its
 * `Priority` field *is* the `priority::` scoped label.
 *
 * So this picks from the priority labels that exist, and choosing one **writes a label on the
 * Issue** — not a field value, because the field is not where this project keeps its priority. The
 * popover says so in its heading rather than leaving the operator to discover it from a diff.
 *
 * The one label it touches is the priority one. Every other label on the issue is carried through
 * untouched, and clearing removes the priority label and nothing else.
 */
export function PriorityCell({
  current,
  choices,
  rowTitle,
  onPick,
  pending,
}: {
  current: DerivedPriority | null;
  /** The priority labels this workspace's repositories define, most urgent first. */
  choices: readonly PriorityChoice[];
  rowTitle: string;
  onPick: (label: string | null) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`Priority for ${rowTitle}`}
          disabled={pending}
          className={cn(
            TOKEN,
            "w-fit max-w-full justify-between hover:bg-accent/50 disabled:opacity-50",
            !current && "border-dashed font-normal text-muted-foreground/60",
          )}
          style={optionTone(choices.find((c) => c.label === current?.label)?.color ?? undefined)}
          // Not a value the provider holds in this field, and the cell says which label it read.
          title={
            current
              ? `Read from the label \u201C${current.label}\u201D. This project's Priority field holds no value for this row.`
              : undefined
          }
        >
          <span className="min-w-0 truncate">{current?.name ?? "\u2014"}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <p className="border-b px-3 py-2 font-medium text-2xs text-muted-foreground">
            {/* The heading carries the whole disclosure: this writes a label. */}
            Set priority — written as a label on the issue
          </p>
          <CommandInput placeholder="Filter priorities" className="h-8" />
          <CommandList>
            <CommandEmpty>
              {choices.length === 0
                ? "No priority labels found in these repositories."
                : "No priority matches."}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__clear"
                onSelect={() => {
                  setOpen(false);
                  onPick(null);
                }}
              >
                <span className="text-muted-foreground">Clear</span>
                {!current && <Check className="ml-auto size-3.5" />}
              </CommandItem>
              {choices.map((choice) => (
                <CommandItem
                  key={choice.label}
                  value={`${choice.name} ${choice.label}`}
                  onSelect={() => {
                    setOpen(false);
                    onPick(choice.label);
                  }}
                >
                  <span
                    className={cn(TOKEN, "shrink-0")}
                    style={optionTone(choice.color ?? undefined)}
                  >
                    {choice.name}
                  </span>
                  {/* The label itself, quietly, so the write is legible before it happens. */}
                  <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                    {choice.label}
                  </span>
                  {current?.label === choice.label && <Check className="ml-auto size-3.5" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ProjectCell({
  field,
  value,
  rowTitle,
  onEdit,
  pending = false,
  fallback,
  counterpart,
  today,
}: CellProps) {
  if (field.readOnly && field.readOnlyReason) {
    /*
     * A value, and nothing else.
     *
     * This used to draw a padlock beside every read-only cell with the provider's reason in a
     * tooltip. At one glyph per cell that is a column of padlocks saying the same thing forty
     * times about a property of the *column*, not of any row — so the reason moved to the column
     * header, where it is said once, and the cells got their space back.
     */
    return (
      <span
        className={cn(
          "block truncate text-xs text-muted-foreground",
          field.type === "number" && "text-right tabular-nums",
        )}
      >
        {formatCellValue(value, field) || fallback || "—"}
      </span>
    );
  }

  // Assignees are the provider's, and this table does not author them (F23 FR-8). The side panel
  // is where they are changed, through the provider — a cell that let you drag someone onto a row
  // would be editing a copy.
  if (value?.type === "user") return <UserCell value={value} />;

  if (onEdit) {
    const props = { field, value, rowTitle, onEdit, pending, fallback };
    if (field.type === "single_select") return <SelectCell {...props} />;
    if (field.type === "iteration") return <IterationCell {...props} />;
    if (field.type === "user") return <Empty />;
    if (field.type === "date") {
      return (
        <DateCell {...props} counterpart={counterpart} today={today ?? isoToday(new Date())} />
      );
    }
    return <InputCell {...props} />;
  }

  const option = optionOf(field, value);
  if (option) {
    return (
      <span className={cn(TOKEN, "max-w-full")} style={optionTone(option.color)}>
        <span className="truncate">{option.name}</span>
      </span>
    );
  }
  const text =
    field.type === "date" && value?.type === "date"
      ? formatDate(value.date)
      : formatCellValue(value, field);
  if (!text) return fallback ? fallback : <Empty />;
  return (
    <span
      className={cn("block truncate text-xs", field.type === "number" && "text-right tabular-nums")}
    >
      {text}
    </span>
  );
}
