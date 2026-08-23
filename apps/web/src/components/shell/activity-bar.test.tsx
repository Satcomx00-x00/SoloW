/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The activity rail (track D, WIP badges). `ActivityBar` reads `usePathname` and imports
 * `signOut` from the auth client, so both are stubbed the way `sign-in-form.test.tsx` stubs its
 * own dependencies — nothing here exercises navigation or sign-out, only what the rail renders.
 */

// Complete, not just what this file needs: `mock.module` replaces the module for the rest of
// the bun:test process, and a stub missing a hook breaks whichever other file's component reads
// it next (see issue-detail.test.tsx's fuller account of this leak).
mock.module("next/navigation", () => ({
  usePathname: () => "/board",
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Same completeness reasoning as the next/navigation mock above: sign-in-form.test.tsx's own
// stub of this module has both signIn and signUp, and an incomplete stub registered after it
// leaks a "signUp not found" SyntaxError into whichever file next imports the real specifier.
mock.module("@/lib/auth-client", () => ({
  signOut: async () => {},
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
}));

const { ActivityBar } = await import("./activity-bar");

afterEach(cleanup);

describe("ActivityBar", () => {
  it("marks the Workflows entry as work in progress, and no other entry", () => {
    render(
      <TooltipProvider>
        <ActivityBar signedIn={false} />
      </TooltipProvider>,
    );

    const badges = screen.getAllByText("WIP");
    expect(badges).toHaveLength(1);
    const badge = badges[0];
    if (!badge) throw new Error("expected a WIP badge");

    const workflowsLink = screen.getByRole("link", { name: /Workflows \(work in progress\)/ });
    expect(workflowsLink.contains(badge)).toBe(true);

    for (const name of [/^Board$/, /^Issues$/, /^Settings$/]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });
});
