"use client";

import { PanelRight, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The second half of VS Code's two-sidebar shell: a right-hand panel for what the *selected*
 * thing is, opposite the left one's list of what there is to select.
 *
 * The split is the point. A left sidebar that also held the selection's properties has to choose
 * on every screen between showing you the list and showing you the thing, and the Workflow
 * designer is exactly where that broke down — the list, the create form, the pipeline's name and
 * the graph were all competing for one column. Navigation on the left, inspection on the right,
 * the document in the middle.
 *
 * **It is a portal outlet, not a component with a `switch` in it**, for the same reason
 * `HeaderActions` is: the shell must not learn what a Workflow is in order to give it a panel.
 * A surface renders `<SecondaryPanel title="…">` from wherever it already has the data loaded,
 * and the shell only knows that *something* is contributing — which is also all it needs to
 * decide whether the panel and its toggle exist at all. Nothing contributing means no empty
 * frame and no dead button.
 */
export const SECONDARY_PANEL_ID = "shell-secondary-panel";

interface SecondarySidebarHandle {
  open: boolean;
  toggle: () => void;
  /** What the panel's header says — supplied by whoever is contributing to it. */
  title: string | null;
  /** Register as the current contributor; the returned function unregisters. */
  claim: (title: string) => () => void;
}

const SecondarySidebarContext = createContext<SecondarySidebarHandle | null>(null);

/**
 * The panel's handle, or null where there is no shell around the caller.
 *
 * Null rather than a thrown error, for the same reason `HeaderActions` renders nothing when it
 * cannot find its outlet: a surface contributes a panel from inside its own tree, and that tree
 * is also rendered on its own — in a unit test, and in any future embedding of a view outside
 * the dashboard. A page must not fail to render because the chrome it was offering something to
 * is absent; it simply has nowhere to put it.
 */
export function useSecondarySidebar(): SecondarySidebarHandle | null {
  return useContext(SecondarySidebarContext);
}

export function SecondarySidebarProvider({ children }: { children: ReactNode }) {
  // Open by default, because it only exists on a surface that asked for it — a panel you have to
  // go and find is one nobody finds.
  const [open, setOpen] = useState(true);
  const [title, setTitle] = useState<string | null>(null);
  /*
   * Counted, not a boolean. Two panels overlap for one commit whenever the route changes — the
   * outgoing surface unmounts after the incoming one mounts — and a boolean would be cleared by
   * the departing one, closing the panel on every navigation between two surfaces that both have
   * one.
   */
  const claims = useRef(0);

  const claim = useCallback((claimed: string) => {
    claims.current += 1;
    setTitle(claimed);
    return () => {
      claims.current -= 1;
      if (claims.current === 0) setTitle(null);
    };
  }, []);

  const handle = useMemo<SecondarySidebarHandle>(
    () => ({ open, toggle: () => setOpen((was) => !was), title, claim }),
    [open, title, claim],
  );

  return (
    <SecondarySidebarContext.Provider value={handle}>{children}</SecondarySidebarContext.Provider>
  );
}

/** The header-bar control that shows and hides the panel. Absent when nothing is contributing. */
export function SecondarySidebarToggle() {
  const handle = useSecondarySidebar();
  if (!handle?.title) return null;
  const { open, toggle, title } = handle;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={open ? `Hide ${title}` : `Show ${title}`}
          aria-expanded={open}
          aria-controls={SECONDARY_PANEL_ID}
          onClick={toggle}
          className={open ? "text-foreground" : "text-muted-foreground"}
        >
          <PanelRight aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{open ? "Hide panel" : "Show panel"}</TooltipContent>
    </Tooltip>
  );
}

/** The panel itself, rendered by the shell to the right of the main region. */
export function SecondarySidebar() {
  const handle = useSecondarySidebar();
  if (!handle?.title || !handle.open) return null;
  const { toggle, title } = handle;
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l bg-sidebar lg:flex" aria-label={title}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
          {title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Hide ${title}`}
          onClick={toggle}
        >
          <X aria-hidden />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div id={SECONDARY_PANEL_ID} />
      </ScrollArea>
    </aside>
  );
}

/** Puts a surface's own controls in the panel. Renders nothing while the panel is hidden. */
export function SecondaryPanel({ title, children }: { title: string; children: ReactNode }) {
  const handle = useSecondarySidebar();
  const claim = handle?.claim;
  const [host, setHost] = useState<HTMLElement | null>(null);
  /*
   * Exactly the condition the shell renders the outlet under, mirrored — not just `open`.
   *
   * The claim below is what *causes* the outlet to exist, and it happens in an effect: on the
   * first commit `title` is still null, so the aside is not in the DOM yet and a lookup keyed on
   * `open` alone would run once, find nothing, and never run again — a panel that is on screen
   * and permanently empty. Keyed on the same expression the shell uses, the claim's re-render is
   * itself what re-runs the lookup, and effects run after that commit is in the DOM.
   */
  const outletRendered = handle !== null && handle.title !== null && handle.open;

  useEffect(() => claim?.(title), [claim, title]);
  useEffect(
    () => setHost(outletRendered ? document.getElementById(SECONDARY_PANEL_ID) : null),
    [outletRendered],
  );

  return host ? createPortal(children, host) : null;
}
