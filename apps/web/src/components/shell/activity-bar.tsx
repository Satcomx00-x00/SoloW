"use client";

import { LogOut, type LucideIcon, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/lib/auth-client";
import { SECTIONS } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "./command-palette";

/**
 * The brand mark: a control barrier with its arm raised. Two uprights and a crossbar was the
 * obvious "gate", but at 16px it just reads as the letter H — the shape has to survive being
 * tiny in the corner of a rail, which is the only place it ever appears.
 */
function Mark() {
  return (
    <span
      className="mb-1.5 flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25 ring-inset"
      aria-hidden
    >
      <svg viewBox="0 0 20 20" className="size-4" fill="none">
        <title>GateControl</title>
        {/* The post, and the arm lifted to let one thing through. */}
        <path d="M5 3.5v13" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        <path
          d="M6.5 12.5 17 6"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          opacity="0.85"
        />
        <circle cx="5" cy="10" r="1.15" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Shared shape for a rail slot, so a link and a button look identical in it. */
const railItem =
  "group relative flex size-8 items-center justify-center rounded-lg transition-colors duration-150";

/**
 * The active marker is a rail-edge bar rather than a filled pill: it reads at a glance from the
 * periphery, which is the whole job of an icon rail you are not looking at.
 */
function ActiveMarker({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "-left-2 absolute w-[2px] rounded-full bg-primary transition-all duration-200",
        active ? "h-4 opacity-100" : "h-0 opacity-0",
      )}
    />
  );
}

function RailLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(
            railItem,
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <ActiveMarker active={active} />
          <Icon className="size-[17px]" strokeWidth={2} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Search sits in the rail because that is where a VS Code user reaches for it, but it opens the
 * command palette rather than navigating — there is no separate search page to go to.
 */
function SearchRailButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Search"
          onClick={openCommandPalette}
          className={cn(
            railItem,
            "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <Search className="size-[17px]" strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Search · ⌘K</TooltipContent>
    </Tooltip>
  );
}

/**
 * Sign out. Only rendered when there is a real session: under the local dev-owner stand-in there
 * is nothing to sign out of, and a dead button would be worse than no button. Whether there is
 * one comes from the layout, which resolved it on the server, so the control does not appear a
 * beat after the rest of the rail.
 */
function SignOutButton() {
  const router = useRouter();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Sign out"
          onClick={async () => {
            await signOut();
            router.replace("/sign-in");
            router.refresh();
          }}
          className={cn(
            railItem,
            "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <LogOut className="size-[17px]" strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Sign out</TooltipContent>
    </Tooltip>
  );
}

/** VS-Code-style activity bar: a thin icon rail for top-level destinations. */
export function ActivityBar({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href ||
    pathname.startsWith(`${href}/`) ||
    // A Task belongs to the board, so opening one keeps the board lit rather than nothing.
    (href === "/board" && pathname.startsWith("/task/"));

  // Settings sits at the foot of the rail, the way it does in VS Code; everything else stacks
  // from the top in declaration order.
  const primary = SECTIONS.filter((s) => s.href !== "/settings");
  const settings = SECTIONS.find((s) => s.href === "/settings");

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2.5">
      <Mark />
      {primary.map((section) => (
        <RailLink
          key={section.href}
          href={section.href}
          label={section.label}
          icon={section.icon}
          active={isActive(section.href)}
        />
      ))}
      <SearchRailButton />
      <div className="mt-auto flex flex-col items-center gap-1">
        {settings && (
          <RailLink
            href={settings.href}
            label={settings.label}
            icon={settings.icon}
            active={isActive(settings.href)}
          />
        )}
        {signedIn && <SignOutButton />}
      </div>
    </aside>
  );
}
