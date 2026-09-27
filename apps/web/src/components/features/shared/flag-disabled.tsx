"use client";

import type { FlagKey } from "@solow/db";
import Link from "next/link";
import { settingsHref } from "@/lib/navigation";

/**
 * What a surface shows when the flag gating it has been turned off.
 *
 * One component rather than the four near-identical copies that lived in `board.tsx`,
 * `issues-view.tsx`, `workflows-view.tsx` and `library-ui.tsx`. They were identical because they
 * said the same thing, and they all said the same *wrong* thing once flags began shipping ON
 * (constitution v1.5.0): "Feature flags ship off. Enable it from the machine running this
 * instance", followed by a `bun run flag enable …` command.
 *
 * Both halves of that were misleading after the flip. A flag is no longer off because it shipped
 * off — it is off because somebody in this Workspace turned it off, which is a different event
 * and deserves a different sentence. And the terminal is no longer the way back: `flag.set` sits
 * on `sessionProcedure` precisely so that the one screen which can undo a kill switch is never
 * itself behind the switch, so the fix is a link. The command stays as a second line, because an
 * operator locked out of the browser for some other reason still needs it.
 */
export function FlagDisabled({ title, flag }: { title: string; flag: FlagKey }) {
  return (
    <div className="space-y-3" role="alert">
      <h2 className="font-medium text-sm">{title}</h2>
      <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
        Someone turned this feature off for this workspace.{" "}
        <Link
          className="underline underline-offset-2 hover:text-foreground"
          href={settingsHref("flags")}
        >
          Turn it back on in Settings → Feature flags
        </Link>
        , or from the machine running this instance:
      </p>
      <pre className="w-fit rounded-lg border bg-card px-3 py-2 font-mono text-xs">
        bun run flag enable {flag}
      </pre>
    </div>
  );
}
