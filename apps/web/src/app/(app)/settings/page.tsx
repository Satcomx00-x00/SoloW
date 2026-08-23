import { Suspense } from "react";
import { Settings } from "@/components/features/settings/settings";

/** `useSearchParams` (the `?renewSecret=` deep link, issue #63) needs a Suspense boundary. */
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
