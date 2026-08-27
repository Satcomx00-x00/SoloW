"use client";

import type { showWidgetWidget } from "@solow/contracts";
import { useId } from "react";
import type { z } from "zod";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

type ShowWidgetWidget = z.infer<typeof showWidgetWidget>;

/**
 * Markup the agent produced, drawn in a sandboxed frame (`show_widget`).
 *
 * This is the one widget whose payload is *code*, so it is the one place where being careless
 * would matter. Three rules, none of them negotiable:
 *
 * **Never the app's own DOM.** No `dangerouslySetInnerHTML`, no inline `<svg>` built from the
 * string. A model wrote this markup and the page it would land on holds the operator's session
 * and a repository's diff; an `<img onerror>` in the same document reaches both. It renders in an
 * `<iframe srcDoc>` instead, which is a separate document with its own origin.
 *
 * **No `allow-same-origin`, ever.** That single token would hand the frame back the ability to
 * reach this document, which is the whole thing the sandbox exists to prevent. Its absence is why
 * `allow-scripts` is safe to grant at all.
 *
 * **Scripts only where the module says so.** A diagram, a chart or a piece of art is static
 * markup and gets no script engine. `interactive` and `mockup` are the modules that mean "this
 * has behaviour", and they are the only ones that get `allow-scripts` — still inside an origin
 * that can reach nothing.
 */
export function ShowWidget({ widget }: WidgetRendererProps<ShowWidgetWidget>) {
  const titleId = useId();
  const scripted = widget.module === "interactive" || widget.module === "mockup";

  return (
    <figure
      data-widget="show_widget"
      data-module={widget.module}
      className="min-w-0 space-y-1.5 rounded-xl border bg-card p-2"
    >
      {widget.title && (
        <figcaption id={titleId} className="px-1 font-medium text-xs">
          {widget.title}
        </figcaption>
      )}
      <iframe
        title={widget.title ?? `Agent ${widget.module.replace("_", " ")}`}
        aria-labelledby={widget.title ? titleId : undefined}
        // `srcDoc` and not `src`: the content never becomes a URL, so nothing about it is fetched,
        // cached or shareable. The document is exactly the string the agent emitted.
        srcDoc={frameDocument(widget)}
        sandbox={scripted ? "allow-scripts" : ""}
        // Referrer and permission policies are belt to the sandbox's braces: a frame with no
        // origin still should not be able to ask for a camera or leak this page's URL.
        referrerPolicy="no-referrer"
        allow=""
        className={cn("w-full rounded-lg border-0 bg-white", FRAME_HEIGHT[widget.module])}
      />
    </figure>
  );
}

/**
 * How tall to draw each module.
 *
 * A cross-origin frame cannot report its own content height — that is the sandbox working, not a
 * limitation to route around — so the height is a guess made per module rather than per payload.
 * A diagram or a chart is wide and short; something interactive is a small application and needs
 * room to be one.
 */
const FRAME_HEIGHT: Record<z.infer<typeof showWidgetWidget>["module"], string> = {
  diagram: "h-48",
  chart: "h-48",
  data_viz: "h-56",
  art: "h-56",
  mockup: "h-72",
  interactive: "h-72",
  elicitation: "h-48",
};

/**
 * Wrap the payload in a minimal document.
 *
 * A white background rather than the app's dark one: an SVG or a chart written by a model
 * overwhelmingly assumes a light canvas and states no background of its own, so honouring the
 * app's theme here would render black strokes on black. The frame is a picture in the transcript,
 * not a continuation of the page's surface.
 */
function frameDocument(widget: ShowWidgetWidget): string {
  const body =
    widget.format === "svg" ? `<div class="wrap">${widget.content}</div>` : widget.content;
  return [
    "<!doctype html><html><head><meta charset='utf-8'>",
    // No external anything: a content-security-policy inside the frame means a model that writes
    // <script src="https://…"> or a tracking pixel gets nothing, sandbox or not.
    "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:\">",
    "<style>html,body{margin:0;padding:8px;font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:#111}",
    ".wrap svg{max-width:100%;height:auto;display:block;margin:0 auto}img{max-width:100%}</style>",
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}
