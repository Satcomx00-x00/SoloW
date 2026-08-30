"use client";

import type { RepositoryLabelDto } from "@solow/contracts";
import { Bold, Code, Heading, Italic, Link2, List, ListChecks, Quote } from "lucide-react";
import { useRef } from "react";
import { AgentMarkdown } from "@/components/features/task/markdown";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

/**
 * The two pieces the create dialog and the edit drawer both need (user request 2026-08-30).
 *
 * They live here rather than in either surface because they are the same behaviour in both, and a
 * second copy is how the two drift: a toolbar button added to one, a label family recognised by
 * one. An issue's description is Markdown wherever it is written, and its labels group the same
 * way wherever they are picked.
 */

/**
 * The scoped-label families the Labels picker splits into their own headed groups, in the order
 * request 2026-08-30 named them: **Area · Priority · Size · Status · Type**. A label joins one when
 * its prefix — the part before the first `::` (a GitLab scoped label) or `/` (the `type/feat`
 * convention `DEFAULT_LABEL_TAXONOMY` seeds) — matches case-insensitively; `prio` and `priority`
 * are the same family. Every other label falls through to one shared, unheaded group — "else are
 * all in the same dropdown list" — so a repository with no scoped labels shows exactly the flat
 * list it always did.
 */
const LABEL_CATEGORIES: ReadonlyArray<{ key: string; heading: string; match: readonly string[] }> =
  [
    { key: "area", heading: "Area", match: ["area"] },
    { key: "priority", heading: "Priority", match: ["prio", "priority"] },
    { key: "size", heading: "Size", match: ["size"] },
    { key: "status", heading: "Status", match: ["status"] },
    { key: "type", heading: "Type", match: ["type"] },
  ];

interface GroupedLabel extends RepositoryLabelDto {
  /** What the row shows: the value after the prefix for a categorised label, else the whole name. */
  short: string;
}
interface LabelGroup {
  key: string;
  /** `null` for the shared fall-through group — rendered without a heading. */
  heading: string | null;
  items: GroupedLabel[];
}

/** Split a label name into `prefix` and `value` on the first `::` or `/`; `null` when it has neither. */
function splitScoped(name: string): { prefix: string; value: string } | null {
  const hasScoped = name.includes("::");
  const at = hasScoped ? name.indexOf("::") : name.indexOf("/");
  if (at <= 0) return null; // no separator, or one with an empty prefix (`::x`, `/x`)
  const sepLen = hasScoped ? 2 : 1;
  return { prefix: name.slice(0, at), value: name.slice(at + sepLen) };
}

/**
 * Group a repository's labels for the picker (F23a — request 2026-08-30). Pure, and exported so the
 * rule — five known families become headed groups in a fixed order, everything else shares one flat
 * group — is tested without rendering the popover.
 */
export function groupLabelsByCategory(labels: readonly RepositoryLabelDto[]): LabelGroup[] {
  const buckets = new Map<string, GroupedLabel[]>();
  const other: GroupedLabel[] = [];
  for (const label of labels) {
    const scoped = splitScoped(label.name);
    const category = scoped
      ? LABEL_CATEGORIES.find((c) => c.match.includes(scoped.prefix.toLowerCase()))
      : undefined;
    if (scoped && category) {
      const list = buckets.get(category.key) ?? [];
      list.push({ ...label, short: scoped.value });
      buckets.set(category.key, list);
    } else {
      other.push({ ...label, short: label.name });
    }
  }
  const groups: LabelGroup[] = [];
  for (const category of LABEL_CATEGORIES) {
    const items = buckets.get(category.key);
    if (items && items.length > 0)
      groups.push({ key: category.key, heading: category.heading, items });
  }
  if (other.length > 0) groups.push({ key: "__other", heading: null, items: other });
  return groups;
}

/**
 * The description editor — Markdown, written or previewed (request 2026-08-30).
 *
 * **Write** is a plain textarea with a formatting toolbar; **Preview** renders the same text
 * through `AgentMarkdown`, the very renderer `IssueBody` shows a saved description with, so what a
 * person previews here is what the issue will read as. The toolbar acts on the live selection —
 * the textarea is reached through the container rather than a `ref`, because the shared `Textarea`
 * does not forward one — and every action is a pure string transform, so it is inert (guarded) when
 * the Preview tab has the textarea unmounted.
 */
export function MarkdownField({
  value,
  onChange,
  label = "Description",
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textarea = () => boxRef.current?.querySelector("textarea") ?? null;

  /** Wrap the selection (or a hint word, when the selection is empty) in `before`/`after` markers. */
  const surround = (before: string, after: string, hint: string) => {
    const ta = textarea();
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const sel = value.slice(s, e) || hint;
    onChange(value.slice(0, s) + before + sel + after + value.slice(e));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    });
  };

  /** Prefix every line the selection touches — a heading, quote, bullet or checklist item. */
  const prefixLines = (prefix: string) => {
    const ta = textarea();
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const from = value.lastIndexOf("\n", s - 1) + 1;
    const block = value.slice(from, e);
    const replaced = block.replace(/^/gm, prefix);
    onChange(value.slice(0, from) + replaced + value.slice(e));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(from, e + (replaced.length - block.length));
    });
  };

  const actions = [
    { label: "Bold", icon: Bold, run: () => surround("**", "**", "bold") },
    { label: "Italic", icon: Italic, run: () => surround("_", "_", "italic") },
    { label: "Inline code", icon: Code, run: () => surround("`", "`", "code") },
    { label: "Heading", icon: Heading, run: () => prefixLines("### ") },
    { label: "Quote", icon: Quote, run: () => prefixLines("> ") },
    { label: "Bulleted list", icon: List, run: () => prefixLines("- ") },
    { label: "Task list", icon: ListChecks, run: () => prefixLines("- [ ] ") },
    { label: "Link", icon: Link2, run: () => surround("[", "](https://)", "text") },
  ] as const;

  return (
    <div ref={boxRef} className="grid gap-2">
      <span className="font-medium text-sm">{label}</span>
      <Tabs defaultValue="write">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-0.5">
            {actions.map((a) => (
              <Button
                key={a.label}
                type="button"
                variant="ghost"
                size="icon-xs"
                title={a.label}
                aria-label={a.label}
                onClick={a.run}
              >
                <a.icon aria-hidden />
              </Button>
            ))}
          </div>
        </div>
        <TabsContent value="write" className="mt-2">
          <Textarea
            aria-label={label}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Optional. Markdown is supported — **bold**, lists, `code`, tables."
            className="min-h-[12rem] font-mono text-xs"
          />
        </TabsContent>
        <TabsContent value="preview" className="mt-2">
          <div className="min-h-[12rem] rounded-md border bg-muted/20 px-3 py-2">
            {value.trim() ? (
              <AgentMarkdown text={value} />
            ) : (
              <p className="text-muted-foreground text-sm italic">Nothing to preview.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
