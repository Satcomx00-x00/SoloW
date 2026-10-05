"use client";

import { PanelLeft, PanelLeftClose } from "lucide-react";
import { usePathname } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SIDEBAR_COOKIE } from "./sidebar-cookie";
import { SidebarNav } from "./sidebar-nav";

/**
 * The app's one sidebar (Decision 0029): labelled destinations in a single column, with the open
 * Project's sections nested under it.
 *
 * It replaced an icon rail plus a second column whose contents changed with every route. Two
 * columns cost ~290px before any content, the rail's icons had no names, and the second column
 * meant something different on each page — a list of sections, a column of counts, a create form.
 * One column that says the same thing everywhere, and can be put away, is the whole design.
 *
 * Hidden or shown is remembered in a cookie rather than `localStorage`, because the server renders
 * the shell: the layout reads the cookie and the first paint is already the right width, where a
 * value only the browser knows would paint the sidebar and then snap it shut.
 *
 * Below `md` it is a drawer instead — there is no width to spare for a column on a phone — opened
 * from the header and closed by navigating.
 */

interface SidebarHandle {
  /** Desktop: whether the column is shown. */
  open: boolean;
  /** Below `md`: whether the drawer is open. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  /** Shows or hides whichever of the two applies at the current width. */
  toggle: () => void;
  /** The last page outside Settings, so Settings' back link returns where you were. */
  lastAppPath: string;
}

const SidebarContext = createContext<SidebarHandle | null>(null);

/** Null outside the shell — a surface rendered on its own (a unit test) has no sidebar. */
export function useSidebar(): SidebarHandle | null {
  return useContext(SidebarContext);
}

const MOBILE_QUERY = "(max-width: 767px)";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export function SidebarProvider({
  children,
  defaultOpen,
}: {
  children: ReactNode;
  /** From the cookie, read by the layout on the server. */
  defaultOpen: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(defaultOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const lastAppPath = useRef("/projects");

  useEffect(() => {
    if (!pathname.startsWith("/settings")) lastAppPath.current = pathname;
  }, [pathname]);

  // Navigating is what closes a drawer: it covers the page you just asked for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is the trigger, not an input
  useEffect(() => setMobileOpen(false), [pathname]);

  const toggle = useCallback(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) {
      setMobileOpen((was) => !was);
      return;
    }
    setOpen((was) => {
      const next = !was;
      // biome-ignore lint/suspicious/noDocumentCookie: the server reads this on the next render
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "open" : "closed"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);

  /*
   * ⌘B / Ctrl+B, the binding VS Code, Linear and every shadcn sidebar share — except while typing,
   * where it belongs to the field (bold, in an editor that has it).
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "b" || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      if (event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // `pathname` is a dependency for `lastAppPath`: the ref is read when the handle is built, so the
  // handle has to be rebuilt on the navigation that changed it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const handle = useMemo<SidebarHandle>(
    () => ({ open, mobileOpen, setMobileOpen, toggle, lastAppPath: lastAppPath.current }),
    [open, mobileOpen, toggle, pathname],
  );

  return <SidebarContext.Provider value={handle}>{children}</SidebarContext.Provider>;
}

/** The sidebar, as a column on `md` and up and as a drawer below it. */
export function Sidebar({ workspaceName, signedIn }: { workspaceName: string; signedIn: boolean }) {
  const handle = useSidebar();
  if (!handle) return null;
  return (
    <>
      {handle.open && (
        <aside
          aria-label="Sidebar"
          className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex"
        >
          <SidebarNav workspaceName={workspaceName} signedIn={signedIn} />
        </aside>
      )}
      <Sheet open={handle.mobileOpen} onOpenChange={handle.setMobileOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-72 max-w-[85vw] gap-0 bg-sidebar p-0 md:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Projects, workspace pages and recent tasks
          </SheetDescription>
          <SidebarNav workspaceName={workspaceName} signedIn={signedIn} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Shows the sidebar from the header. Only rendered where the sidebar is not already on screen —
 * when it is, its own footer button is the way to put it away, and a second switch for the same
 * thing in the header would be one control too many.
 */
export function SidebarShowButton() {
  const handle = useSidebar();
  if (!handle) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Show sidebar"
          onClick={handle.toggle}
          className={handle.open ? "md:hidden" : undefined}
        >
          <PanelLeft aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Show sidebar · ⌘B</TooltipContent>
    </Tooltip>
  );
}

/** Puts the sidebar away; lives in the sidebar's own footer. */
export function SidebarHideButton() {
  const handle = useSidebar();
  if (!handle) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Hide sidebar"
          onClick={handle.toggle}
          className="text-muted-foreground"
        >
          <PanelLeftClose aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Hide sidebar · ⌘B</TooltipContent>
    </Tooltip>
  );
}
