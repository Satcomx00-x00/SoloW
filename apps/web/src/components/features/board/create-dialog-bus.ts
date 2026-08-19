"use client";

/**
 * Lets something outside the board ask a create dialog to open — currently the command palette.
 *
 * An event rather than a `?new=task` URL parameter: the parameter had to be consumed on arrival
 * so that a refresh or a Back did not reopen the dialog, which meant a `router.replace` on every
 * mount. This carries the same intent without leaving a trace in history.
 *
 * `"issue"` is gone (issue #15): there is no create-Issue dialog any more — every Issue is
 * imported from a connected GitHub/GitLab repository (Settings → Integrations, or the Issues
 * page's Import dialog), never typed by hand.
 */
export type CreateKind = "task";

const EVENT = "gatecontrol:open-create-dialog";

export function openCreateDialog(kind: CreateKind) {
  document.dispatchEvent(new CustomEvent(EVENT, { detail: kind }));
}

/** Subscribe to requests for one kind. Returns the unsubscribe function. */
export function onOpenCreateDialog(kind: CreateKind, open: () => void): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<CreateKind>).detail === kind) open();
  };
  document.addEventListener(EVENT, handler);
  return () => document.removeEventListener(EVENT, handler);
}
