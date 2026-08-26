import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/features/auth/sign-in-form";
import { ownerExists } from "@/server/auth/auth";
import { resolveSession } from "@/server/auth/session";
import { devOwnerMode } from "@/server/env";

/**
 * Sign-in / first-run setup (task TASK-011). Whether this is a sign-in or the one-time Owner
 * setup is decided on the server, so the page never advertises "create an account" on an
 * instance that already has its Owner.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SignInPage() {
  // Under the local dev-owner stand-in there is no sign-in to do.
  if (devOwnerMode()) redirect("/projects");
  if (await resolveSession(await headers())) redirect("/projects");

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden p-6">
      {/*
        Two very wide, very faint radial washes behind the card. They do the job a photograph
        would do on a marketing page — give the eye somewhere to rest and stop a full-bleed dark
        field reading as an empty buffer — without pretending this screen is a landing page.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklab,var(--primary)_16%,transparent),transparent_70%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(40rem_30rem_at_50%_120%,color-mix(in_oklab,var(--state-running)_10%,transparent),transparent_70%)]"
      />

      <div className="relative flex flex-col items-center">
        <span
          className="mb-6 flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25 ring-inset"
          aria-hidden
        >
          <svg viewBox="0 0 20 20" className="size-5" fill="none">
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
        <SignInForm ownerExists={await ownerExists()} />
      </div>
    </main>
  );
}
