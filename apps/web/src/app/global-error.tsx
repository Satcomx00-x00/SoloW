"use client";

import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { useEffect } from "react";
import { RenderError } from "@/components/features/shared/render-error";
import { applyCachedTheme } from "@/components/theme";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-boot";
import "./globals.css";

/**
 * The root layout itself failed, so nothing it provides exists: this replaces it whole and has to
 * bring its own `<html>`, `<body>`, fonts and stylesheet.
 *
 * The theme is put on twice, for the two ways this renders. Server-rendered, the boot script runs
 * before the first paint, as it does in the layout. Swapped in on the client, React owns `<html>`
 * and writes its `className`, dropping the class the script set long ago — and an inserted
 * `<script>` never runs — so the effect re-applies the cached choice. Without either, a dark-theme
 * Owner gets a white page.
 */
export default function GlobalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => applyCachedTheme(), []);

  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <title>SoloW</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the same fixed string the root
            layout runs before first paint; nothing in it is user-supplied. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <main className="flex min-h-[100dvh] flex-col">
          <RenderError {...props} />
        </main>
      </body>
    </html>
  );
}
