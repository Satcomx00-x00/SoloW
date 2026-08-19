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
 * A GateControl instance has exactly one Owner, so this is one form in two modes rather than two
 * pages: before the Owner exists it creates the account, afterwards it signs in. The server is
 * the authority on which — `ownerExists` is read there and passed in — and it refuses a second
 * account regardless of what this form sends.
 */

/** Kept in step with BetterAuth's `minPasswordLength`; shown so the rule is not a surprise. */
const MIN_PASSWORD_LENGTH = 12;

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
        setError(result.error.message ?? "Sign-in failed.");
        return;
      }
      // A full navigation, not a client push: the session cookie has to reach the server
      // before the board's first request goes out.
      router.replace("/board");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-[380px]">
      <div className="surface-edge rounded-2xl border bg-card/80 p-7 shadow-float backdrop-blur-xl">
        <div className="mb-6 space-y-1.5">
          <h1 className="font-semibold text-xl tracking-[-0.01em]">
            {ownerExists ? "Sign in" : "Set up GateControl"}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {ownerExists
              ? "Sign in to your GateControl workspace."
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
        Self-hosted. Your agent credentials never leave this machine.
      </p>
    </div>
  );
}
