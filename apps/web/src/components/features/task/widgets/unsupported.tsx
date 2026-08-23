"use client";

import type { unsupportedWidget } from "@gatecontrol/contracts";
import { PackageOpen } from "lucide-react";
import type { z } from "zod";
import type { WidgetRendererProps } from "./registry";

type UnsupportedWidgetPayload = z.infer<typeof unsupportedWidget>;

/**
 * A widget this build cannot draw.
 *
 * It exists so that an agent's emission is never silently swallowed: a catalogued widget nobody
 * has implemented yet, and a payload that failed its schema, both land here with the reason
 * attached. Without it the failure mode is the worst one available — the agent believes it
 * showed you something, and you never saw anything at all.
 */
export function UnsupportedWidget({ widget }: WidgetRendererProps<UnsupportedWidgetPayload>) {
  return (
    <div
      data-widget="unsupported"
      className="flex items-start gap-2 rounded-xl border border-dashed bg-card/40 p-3 text-xs"
      role="note"
    >
      <PackageOpen aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 text-muted-foreground leading-relaxed">
        The agent asked for a <span className="font-mono text-foreground">{widget.requested}</span>{" "}
        widget. {widget.reason}
      </p>
    </div>
  );
}
