"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Sign-in, or first-run Owner setup (task TASK-011).
 *
 * A SoloW instance has exactly one Owner, so this is one form in two modes rather than two
 * pages: before the Owner exists it creates the account, afterwards it signs in. The server is
 * the authority on which — `ownerExists` is read there and passed in — and it refuses a second
 * account regardless of what this form sends.
 */

/** Kept in step with BetterAuth's `minPasswordLength`; shown so the rule is not a surprise. */
const MIN_PASSWORD_LENGTH = 12;

/** What BetterAuth's client hands back on a refusal: a code for the known ones, and the HTTP status. */
interface AuthFailure {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

/**
 * A BetterAuth refusal as a sentence with a next step.
 *
 * The form used to show BetterAuth's own message, which is written for the developer wiring it
 * up: a fresh install opened at `127.0.0.1` instead of `localhost` was told "Invalid origin" and
 * nothing else. Matched on `code` — the message is English prose BetterAuth is free to reword —
 * and on the status for the rate limiter, which answers with no code at all.
 */
export function describeAuthFailure(
  failure: AuthFailure,
  mode: "sign-in" | "sign-up",
  origin: string,
): string {
  switch (failure.code) {
    case "INVALID_ORIGIN":
    case "MISSING_OR_NULL_ORIGIN":
    case "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED":
      return `SoloW is not set up to accept sign-ins from ${origin}. Open it at the address it was started with, or set SOLOW_WEB_URL to ${origin} and restart SoloW.`;
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
    case "USER_NOT_FOUND":
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "That email and password don't match the owner account. Check both, then try again.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
    case "FAILED_TO_CREATE_USER":
      // The only user creation SoloW refuses is a second Owner (the hook in `server/auth`), so
      // in setup mode this means another tab or person finished setup first.
      return mode === "sign-up"
        ? "This SoloW already has its owner account, and only one can be created. Reload the page to sign in instead."
        : "The account could not be created. Reload the page, then try again.";
    case "PASSWORD_TOO_SHORT":
      return `That password is too short. Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "PASSWORD_TOO_LONG":
      return "That password is too long. Use a shorter one.";
    case "INVALID_EMAIL":
      return "That doesn't look like an email address. Check it, then try again.";
  }
  if (failure.status === 429) {
    return "Too many attempts in a short time. Wait a minute, then try again.";
  }
  if (failure.status !== undefined && failure.status >= 500) {
    return "SoloW could not complete this. Try again; if it keeps happening, check the server log.";
  }
  return mode === "sign-up"
    ? "The owner account could not be created. Check the fields, then try again."
    : "Sign-in didn't work. Check your email and password, then try again.";
}

export function SignInForm({ ownerExists }: { ownerExists: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = ownerExists
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email });
      if (result.error) {
        setError(
          describeAuthFailure(
            result.error,
            ownerExists ? "sign-in" : "sign-up",
            window.location.origin,
          ),
        );
        return;
      }
      // A full navigation, not a client push: the session cookie has to reach the server
      // before the board's first request goes out.
      router.replace("/projects");
      router.refresh();
    } catch {
      setError("Could not reach SoloW. Check it is still running, then try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-[380px]">
      <div className="surface-edge rounded-2xl border bg-card/80 p-7 shadow-float backdrop-blur-xl">
        <div className="mb-6 space-y-1.5">
          <h1 className="font-semibold text-xl tracking-[-0.01em]">
            {ownerExists ? "Sign in" : "Set up SoloW"}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {ownerExists
              ? "Sign in to your SoloW workspace."
              : "Create the owner account for this instance. Only one account can be created."}
          </p>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          {!ownerExists && (
            <div className="grid gap-1.5">
              <Label htmlFor="auth-name">Name</Label>
              <Input
                id="auth-name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="auth-email">Email</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={ownerExists ? "current-password" : "new-password"}
              required
              minLength={ownerExists ? undefined : MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!ownerExists && (
              <p className="text-2xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>
          {error && (
            <p
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="mt-1 w-full" loading={pending}>
            {ownerExists ? "Sign in" : "Create owner account"}
            {!pending && <ArrowRight />}
          </Button>
        </form>
      </div>

      <p className="mt-5 text-center text-2xs text-muted-foreground/70 leading-relaxed">
        Self-hosted. Your harness credentials never leave this machine.
      </p>
    </div>
  );
}
