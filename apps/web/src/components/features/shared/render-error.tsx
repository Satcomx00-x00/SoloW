"use client";

import { ArrowLeft, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { StatusScreen } from "./status-screen";

/**
 * What an error boundary shows when a page throws while rendering.
 *
 * Never the error's own message: in production Next replaces it with a generic line anyway, and
 * in development it is a stack-trace sentence written for whoever wrote the component. The
 * `digest` is shown instead, because it is the one thing that finds the matching entry in the
 * server log, which is where the real cause is.
 */
export function RenderError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only place a client-side render failure is recorded at all.
    console.error(error);
  }, [error]);

  return (
    <StatusScreen
      code="Error"
      title="This page hit a problem"
      actions={
        <>
          <Button size="sm" onClick={reset}>
            <RotateCcw /> Try again
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/projects">
              <ArrowLeft /> Go to projects
            </Link>
          </Button>
        </>
      }
    >
      <p>
        Something went wrong while showing it. Try again; if it keeps happening, reload the page or
        check the SoloW server log.
      </p>
      {error.digest && (
        <p className="text-xs">
          Reference for the server log: <code className="font-mono">{error.digest}</code>
        </p>
      )}
    </StatusScreen>
  );
}
