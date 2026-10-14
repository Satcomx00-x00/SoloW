"use client";

import { RenderError } from "@/components/features/shared/render-error";

/**
 * A page inside the signed-in shell failed to render. Declared at the group so the shell's own
 * layout — the sidebar — stays standing around the message, and every other page is still a
 * click away.
 */
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RenderError {...props} />;
}
