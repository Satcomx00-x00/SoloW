/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The activity rail (track D, WIP badges). `ActivityBar` reads `usePathname` and imports
 * `signOut` from the auth client, so both are stubbed the way `sign-in-form.test.tsx` stubs its
 * own dependencies — nothing here exercises navigation or sign-out, only what the rail renders.
 */

mock.module("next/navigation", () => ({
  usePathname: () => "/board",
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

mock.module("@/lib/auth-client", () => ({
  signOut: async () => {},
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
