import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "GateControl",
  description: "Orchestrate AI coding agents in parallel under human review.",
};

/**
 * Geist and Geist Mono, self-hosted through `next/font` (no render-blocking external request,
 * no layout shift). The monospace face is not decoration here: agent output, branch names and
 * task ids are read character by character, and leaving that to whatever the operating system
 * happens to supply means the terminal looks different on every machine.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Dark by default: this is a console that sits open beside an editor all day.
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
        <div className="grain-overlay" aria-hidden />
      </body>
    </html>
  );
}
