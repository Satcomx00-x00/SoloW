"use client";

import { createContext, useContext } from "react";
import type { AppContext } from "./contributions";

/**
 * The `AppContext` a surface resolves its contributions against, made available to the
 * contributions themselves (issue #3).
 *
 * Contributed components take no props — the surface does not know what any of them needs, and
 * a prop bag it did know about would be a per-feature branch by another name. So the surface
 * publishes the same context its `when` predicates were evaluated against, and an item reads the
 * parts it cares about. The default is the honest one for an unwrapped tree: nobody signed in.
 */
const DEFAULT_APP_CONTEXT: AppContext = { identity: null };

const AppContextValue = createContext<AppContext>(DEFAULT_APP_CONTEXT);

export function AppContextProvider({
  value,
  children,
}: {
  value: AppContext;
  children: React.ReactNode;
}) {
  return <AppContextValue.Provider value={value}>{children}</AppContextValue.Provider>;
}

export function useAppContext(): AppContext {
  return useContext(AppContextValue);
}
