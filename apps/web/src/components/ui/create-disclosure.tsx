"use client";

import { ChevronDown, Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Creating something, as a disclosure rather than as the top of the list.
 *
 * Written for Settings first (`SettingsCreate`, still the name every settings section imports),
 * where twelve sections each opened on a permanently-expanded form with a filled primary button
 * above the things you already owned — the loudest object on the page was a blank "Save secret"
 * for a secret that did not exist. Promoted here once the Workflows list in the primary sidebar
 * needed the identical shape: a "New workflow" field that used to sit unconditionally above the
 * pipeline list, the same inversion in miniature. One primitive, so the two cannot drift into two
 * different ideas of what "closed by default" means.
 *
 * Closed by default when anything already exists and open when nothing does — which is the same
 * rule an empty state follows, and it means a first-run visit still lands on the form it needs
 * without every later visit paying for it. The button is `outline`: the primary/filled button
 * belongs to whatever the form saves, not to the act of revealing it.
 */
export function CreateDisclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  /**
   * `null` until the reader touches it, and `defaultOpen` decides until then.
   *
   * Not `useState(defaultOpen)`: the thing that makes a list want to open on its form is the list
   * coming back empty, and that answer arrives a query later than the first render. Seeding the
   * state once would mean a first visit with nothing yet landed on a closed form under an empty
   * state telling it to add one — the exact moment the disclosure exists to get out of the way
   * of. Once the reader opens or closes it themselves, their choice wins and nothing overrides it.
   */
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? defaultOpen;
  const panelId = useId();
  return (
    <div className="border-t pt-4">
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        size="sm"
        type="button"
        variant="outline"
      >
        {open ? <ChevronDown /> : <Plus />}
        {label}
      </Button>
      {/* `hidden` rather than unmounting: a half-typed form should survive being folded away. */}
      <div className="mt-4 space-y-4" hidden={!open} id={panelId}>
        {children}
      </div>
    </div>
  );
}
