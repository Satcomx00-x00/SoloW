"use client";

import type { optionsCardWidget } from "@solow/contracts";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

type OptionsCardWidget = z.infer<typeof optionsCardWidget>;

/**
 * Choices as cards, one of which is picked (`options_card`).
 *
 * The same question `ask_user_input` asks in `single` mode, drawn for options that need a
 * sentence of explanation each — a plan to follow, a library to adopt. Buttons in a row would
 * either truncate those descriptions or wrap into something unreadable.
 */
export function OptionsCard({
  widget,
  onRespond,
  response,
}: WidgetRendererProps<OptionsCardWidget>) {
  const chosen = response?.values[0] ?? null;
  const answering = onRespond !== undefined && response == null;

  return (
    <section
      data-widget="options_card"
      aria-label={widget.title ?? "Options"}
      className="min-w-0 space-y-2 rounded-xl border bg-card/60 p-3"
    >
      {widget.title && <h3 className="font-medium text-sm">{widget.title}</h3>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {widget.options.map((option) => {
          const picked = chosen === option.id;
          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={!answering}
                onClick={() => onRespond?.([option.id])}
                aria-pressed={picked}
                className={cn(
                  "flex h-full w-full flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors duration-100",
                  answering ? "hover:border-ring/40 hover:bg-accent/40" : "cursor-default",
                  picked ? "border-primary/50 bg-primary/[0.06]" : "bg-card",
                  // A settled card dims what was not chosen rather than hiding it: the options
                  // the agent offered are part of the record of what was decided.
                  !answering && !picked && "opacity-55",
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 font-medium text-sm">{option.label}</span>
                  {option.badge && (
                    <Badge variant="secondary" className="shrink-0 text-2xs">
                      {option.badge}
                    </Badge>
                  )}
                </span>
                {option.description && (
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    {option.description}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
