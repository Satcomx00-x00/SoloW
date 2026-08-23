"use client";

import type { Widget, WidgetKind } from "@gatecontrol/contracts";
import type { ComponentType } from "react";
import { AskUserInput } from "./ask-user-input";
import { OptionsCard } from "./options-card";
import { PresentFiles } from "./present-files";
import { ShowWidget } from "./show-widget";
import { StepCard } from "./step-card";
import { UnsupportedWidget } from "./unsupported";

/**
 * Which component draws which widget.
 *
 * A registry rather than a switch in the transcript, for the reason the catalogue in
 * `@gatecontrol/contracts/widget.ts` exists: the agreed set is long and this build implements a
 * slice of it. Adding `weather` should be a schema variant and a file — one line here — and never
 * an edit to the transcript, the row component, or the stream.
 *
 * Every renderer takes the same two things: the widget, and a way to answer it. Presentational
 * widgets ignore the second; the row decides whether answering is still possible at all.
 */

export interface WidgetRendererProps<W extends Widget = Widget> {
  widget: W;
  /**
   * Send the operator's answer. Absent when the widget is settled, when the run is over, or when
   * this widget takes no answer — a renderer that receives no `onRespond` must draw a record,
   * not a control that silently does nothing.
   */
  onRespond?: ((values: string[], text?: string) => void) | undefined;
  /** The answer already given, if any. */
  response?: { values: string[]; text: string | null } | null | undefined;
}

/**
 * The typing here is deliberately narrow at the leaf and wide at the map: each renderer declares
 * the exact variant it draws, and the lookup casts once, in one place, guarded by the `kind` it
 * was keyed on.
 */
type AnyRenderer = ComponentType<WidgetRendererProps<never>>;

const RENDERERS: Record<WidgetKind, AnyRenderer> = {
  ask_user_input: AskUserInput as AnyRenderer,
  show_widget: ShowWidget as AnyRenderer,
  options_card: OptionsCard as AnyRenderer,
  step_card: StepCard as AnyRenderer,
  present_files: PresentFiles as AnyRenderer,
  unsupported: UnsupportedWidget as AnyRenderer,
};

export function rendererFor(kind: WidgetKind): ComponentType<WidgetRendererProps> {
  return RENDERERS[kind] as unknown as ComponentType<WidgetRendererProps>;
}
