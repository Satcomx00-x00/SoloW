import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "GateControl",
  description: "Orchestrate AI coding agents in parallel under human review.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Dark by default for the VS-Code-style dashboard; still the shadcn default (neutral) palette.
    <html lang="en" className="dark">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
