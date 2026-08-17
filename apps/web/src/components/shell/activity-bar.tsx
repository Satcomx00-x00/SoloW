"use client";

import { LayoutDashboard, type LucideIcon, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface RailItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const PRIMARY: RailItem[] = [{ href: "/board", label: "Board", icon: LayoutDashboard }];
const BOTTOM: RailItem[] = [{ href: "/settings", label: "Settings", icon: Settings }];

function RailLink({ item, active }: { item: RailItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={item.href}
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex size-9 items-center justify-center rounded-lg transition-colors",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.9} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** VS-Code-style activity bar: a thin icon rail for top-level destinations. */
export function ActivityBar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <aside className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-3">
      <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground text-sm">
        GC
      </div>
      {PRIMARY.map((item) => (
        <RailLink key={item.href} item={item} active={isActive(item.href)} />
      ))}
      <div className="mt-auto flex flex-col items-center gap-1">
        {BOTTOM.map((item) => (
          <RailLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </div>
    </aside>
  );
}
