import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-boot";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoloW",
  description: "Orchestrate AI coding agents in parallel under human review.",
  // `app/icon.svg` is picked up by Next's file convention; naming it here as well is what stops
  // the browser asking for `/favicon.ico` and getting a 404 on every single page load.
  icons: { icon: "/icon.svg" },
};

/**
 * Geist and Geist Mono, self-hosted through `next/font` (no render-blocking external request,
 * no layout shift). The monospace face is not decoration here: harness output, branch names and
 * task ids are read character by character, and leaving that to whatever the operating system
 * happens to supply means the terminal looks different on every machine.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /*
     * No theme class here any more: which one applies is a per-user preference now (spec F16),
     * and the server cannot know it — the markup it renders is the same for a light and a dark
     * reader. `THEME_BOOT_SCRIPT` puts the class on before the first paint, from a cache the
     * client wrote, which is why `suppressHydrationWarning` is required: by the time React
     * hydrates, `<html>` deliberately no longer matches what the server sent.
     *
     * Dark remains the default for an install that has never chosen — see `DEFAULT_APPEARANCE`.
     */
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed, self-contained string
            built in this repository — the one way to run before the first paint. Decision 0015's
            default-deny is about *agent output*; nothing here is user-supplied. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
        <div className="grain-overlay" aria-hidden />
      </body>
    </html>
  );
}
