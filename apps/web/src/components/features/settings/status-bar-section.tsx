"use client";

import { arrangeContributions } from "@solow/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useSurfaceLayout } from "@/hooks/use-surface-layout";
import { statusItemRegistry } from "@/lib/contributions";
import "@/lib/contributions-boot";

/**
 * Arrange the status bar (issue #3, AC-3).
 *
 * The list is every *registered* item, not every currently *visible* one: an item the user hid
 * has to stay listed or it can never come back, and an item a predicate is hiding right now
 * (the dev-owner segment while signed in) is still theirs to place. Arranging a surface is not
 * looking at it.
 *
 * It is grouped the way the bar is drawn, one list per side, because the bar partitions by slot
 * after resolving the arrangement. A single interleaved list looked like it could move an item
 * from one end of the bar to the other, and could not: the saved order changed, this list
 * changed, and the bar was byte-identical. Two lists say what is actually possible, and the
 * saved order is the groups concatenated in the order the bar draws them, so what is arranged
 * here and what is rendered there are the same sequence.
 *
 * Move up / move down rather than a drag handle. #76 owns the pointer affordance — dnd-kit, the
 * Popover and the Switch are its stated acceptance criteria — and shipping it here would mean
 * building it twice; buttons are keyboard- and screen-reader-operable with nothing extra, which
 * is what that work needs underneath the drag anyway.
 */
const SLOTS = [
  { slot: "left", heading: "Left" },
  { slot: "right", heading: "Right" },
] as const;

export function StatusBarSection() {
  const { layout, move, setVisible } = useSurfaceLayout(statusItemRegistry.surface);
  const arranged = arrangeContributions(statusItemRegistry.list(), layout);
  const groups = SLOTS.map(({ slot, heading }) => ({
    heading,
    items: arranged.filter((item) => item.render.slot === slot),
  }));
  const order = groups.flatMap((group) => group.items.map((item) => item.id));
  const hidden = new Set(layout.hidden);

  return (
    <Card id="status-bar" className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Status bar</CardTitle>
        <CardDescription>
          Choose which segments the status bar shows and the order they appear in. Segments are
          contributed by features, so this list grows as the app does.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {order.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing contributes to the status bar yet.
          </p>
        ) : (
          groups.map(({ heading, items }) =>
            items.length === 0 ? null : (
              <section key={heading} aria-label={`${heading} of the status bar`}>
                <h3 className="mb-1.5 text-2xs text-muted-foreground uppercase tracking-wide">
                  {heading}
                </h3>
                <ul className="divide-y rounded-md border">
                  {items.map((item, index) => {
                    const inputId = `status-item-${item.id}`;
                    return (
                      <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox
                          id={inputId}
                          checked={!hidden.has(item.id)}
                          onCheckedChange={(checked) => setVisible(item.id, checked === true)}
                        />
                        <Label htmlFor={inputId} className="flex-1 font-normal">
                          {item.render.label}
                        </Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${item.render.label} up`}
                          disabled={index === 0}
                          onClick={() => move(order, item.id, -1)}
                        >
                          <ChevronUp aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${item.render.label} down`}
                          disabled={index === items.length - 1}
                          onClick={() => move(order, item.id, 1)}
                        >
                          <ChevronDown aria-hidden />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
          )
        )}
      </CardContent>
    </Card>
  );
}
