/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Sign-in / first-run setup form (task TASK-011). The auth client and the router are the two
 * things this component talks to, so both are stubbed and the assertions are about what it sends
 * and what it shows — including that a failed sign-in says so instead of silently doing nothing.
 */

const calls: { signIn: unknown[]; signUp: unknown[]; replaced: string[] } = {
  signIn: [],
  signUp: [],
  replaced: [],
};
let nextResult: { error?: { message: string } } = {};

mock.module("@/lib/auth-client", () => ({
  signIn: {
    email: async (body: unknown) => {
      calls.signIn.push(body);
      return nextResult;
    },
  },
  signUp: {
    email: async (body: unknown) => {
      calls.signUp.push(body);
      return nextResult;
    },
  },
}));

// Every hook another test file's component might read from `next/navigation` has to be here,
// not just the one this file uses — `mock.module` replaces the module for the rest of the
// bun:test process, and a stub missing a hook breaks whichever *other* file's component reads it
// next (see issue-detail.test.tsx's fuller account of this exact leak, and secrets-section.test.tsx
// for a component this omission broke).
mock.module("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => calls.replaced.push(href),
    refresh: () => {},
  }),
  usePathname: () => "/sign-in",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { SignInForm } = await import("./sign-in-form");

beforeEach(() => {
  calls.signIn = [];
  calls.signUp = [];
  calls.replaced = [];
  nextResult = {};
});
afterEach(cleanup);

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("SignInForm — first run", () => {
  it("creates the owner account and lands on the projects hub", async () => {
    render(<SignInForm ownerExists={false} />);
    expect(screen.getByText(/Only one account can be created/)).toBeDefined();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fill("ada@solow.test", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: /Create owner account/ }));

    await waitFor(() => expect(calls.signUp).toHaveLength(1));
    expect(calls.signUp[0]).toEqual({
      email: "ada@solow.test",
      password: "a-long-enough-password",
      name: "Ada",
    });
    expect(calls.signIn).toHaveLength(0);
    // A Project is the top level, so a first sign-in lands on the list of them — the one
    // screen that makes sense before any Project has been adopted.
    await waitFor(() => expect(calls.replaced).toEqual(["/projects"]));
  });

  it("requires a password long enough for the server to accept", () => {
    render(<SignInForm ownerExists={false} />);
    // Surfaced in the form rather than only as a server rejection after submitting.
    expect(screen.getByLabelText("Password").getAttribute("minLength")).toBe("12");
    expect(screen.getByText(/At least 12 characters/)).toBeDefined();
  });
});

describe("SignInForm — returning owner", () => {
  it("signs in rather than offering to create another account", async () => {
    render(<SignInForm ownerExists />);
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByText(/Only one account can be created/)).toBeNull();

    fill("ada@solow.test", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));

    await waitFor(() => expect(calls.signIn).toHaveLength(1));
    expect(calls.signUp).toHaveLength(0);
  });

  it("shows why a sign-in failed and stays put", async () => {
    nextResult = { error: { message: "Invalid email or password" } };
    render(<SignInForm ownerExists />);

    fill("ada@solow.test", "wrong-password-here");
    fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));

    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
    // Navigating on a failed sign-in would bounce the user straight back, hiding the reason.
    expect(calls.replaced).toEqual([]);
  });
});
