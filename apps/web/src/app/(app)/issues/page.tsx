import { Suspense } from "react";
import { IssuesView } from "@/components/features/issues/issues-view";

/** `useSearchParams` needs a Suspense boundary in the App Router. */
export default function IssuesPage() {
  return (
    <Suspense fallback={null}>
      <IssuesView />
    </Suspense>
  );
}
