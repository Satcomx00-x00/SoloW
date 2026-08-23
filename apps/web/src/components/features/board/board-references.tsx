"use client";

import type { IssueDto } from "@gatecontrol/contracts";
import { createContext, type ReactNode, useContext } from "react";

/**
 * The names behind the ids a Task carries.
 *
 * A `TaskDto` names its Repositories and its Issue by id and nothing else, so a card could say
 * which branch the work is on but not which repository that branch is in, nor which Issue the
 * Task was opened against. Both are one lookup away — `repository.list` and `issue.list` are
 * already in React Query's cache for every screen that has a Repository or Issue picker on it —
 * so the board resolves them once and every card reads from the same two maps.
 *
 * A context rather than another prop threaded down. `blockersFor` is threaded because it is
 * *per-task* data the board derives; this is ambient reference data that no card, column or drag
 * layer has any business forwarding, and passing it by hand would put a sixth parameter on five
 * signatures between the board and the card. `TaskCard` is not memoised, so the usual argument
 * against a context here — re-rendering rows that did not change — does not apply.
 *
 * The default resolves nothing, which is what makes `TaskCard` renderable on its own: with no
 * provider above it, the card simply omits the repository name and the Issue link rather than
 * throwing, and shows exactly what it showed before this existed.
 */
export interface BoardReferences {
  repositoryName: (repositoryId: string) => string | null;
  /**
   * The whole Issue, not just its number.
   *
   * The card only *shows* the number, but its menu edits the Issue — a status override, the title
   * and labels dialog — and both of those need the record the Issue detail page works from. It is
   * the same `issue.list` response either way, so narrowing it here would only mean the card
   * fetching again what the board already holds.
   */
  issue: (issueId: string) => IssueDto | null;
}

const EMPTY: BoardReferences = { repositoryName: () => null, issue: () => null };

const BoardReferencesContext = createContext<BoardReferences>(EMPTY);

export function BoardReferencesProvider({
  value,
  children,
}: {
  value: BoardReferences;
  children: ReactNode;
}) {
  return (
    <BoardReferencesContext.Provider value={value}>{children}</BoardReferencesContext.Provider>
  );
}

export function useBoardReferences(): BoardReferences {
  return useContext(BoardReferencesContext);
}
