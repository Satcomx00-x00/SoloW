"use client";

/**
 * Lets anything in the shell ask one of the create/import dialogs to open — the command palette,
 * the header's Create menu, and the keyboard shortcuts that mirror it.
 *
 * An event rather than a `?new=task` URL parameter: the parameter had to be consumed on arrival
 * so that a refresh or a Back did not reopen the dialog, which meant a `router.replace` on every
 * mount. This carries the same intent without leaving a trace in history.
 *
 * All four kinds live here now (user report: creating and importing issues was spread across the
 * board's Backlog column, the Issues page and Settings, with no single place to reach any of
 * them). `CreateMenu` in the shell header subscribes to every kind and owns the dialogs, so the
 * sender never has to know — or navigate to — the page a dialog used to belong to.
 */
export type CreateKind = "task" | "issue" | "import-issues" | "connect-repository";

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
