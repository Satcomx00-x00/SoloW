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

/**
 * What the sender already knows, so the dialog does not ask for it again.
 *
 * Optional throughout: opening `New task` from the header knows nothing, and opening it from a
 * right-click on a project row knows exactly which issue the task is for. The dialog treats it as
 * a *starting point*, never as a lock — the field stays editable, because a menu click is a
 * shortcut and not a decision.
 */
export interface CreateDialogPreset {
  issueId?: string;
  /**
   * The Repository the Issue belongs to.
   *
   * Needed alongside `issueId`, not instead of it: the Task dialog's Issue picker is narrowed by
   * the chosen Repository and stays disabled ("Select a repository first") until one is picked.
   * Presetting the issue alone therefore looked like it did nothing — the value was in the form
   * and the control that would have shown it was still locked.
   */
  repositoryId?: string;
}

interface CreateDialogRequest {
  kind: CreateKind;
  preset?: CreateDialogPreset;
}

export function openCreateDialog(kind: CreateKind, preset?: CreateDialogPreset) {
  document.dispatchEvent(
    new CustomEvent<CreateDialogRequest>(EVENT, {
      detail: { kind, ...(preset ? { preset } : {}) },
    }),
  );
}

/** Subscribe to requests for one kind. Returns the unsubscribe function. */
export function onOpenCreateDialog(
  kind: CreateKind,
  open: (preset?: CreateDialogPreset) => void,
): () => void {
  const handler = (event: Event) => {
    const request = (event as CustomEvent<CreateDialogRequest>).detail;
    if (request?.kind === kind) open(request.preset);
  };
  document.addEventListener(EVENT, handler);
  return () => document.removeEventListener(EVENT, handler);
}
