import { Suspense } from "react";
import { IssuesView } from "@/components/features/issues/issues-view";

/** `useSearchParams` needs a Suspense boundary in the App Router. */
export default async function ProjectIssuesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <Suspense fallback={null}>
      <IssuesView projectId={projectId} />
    </Suspense>
  );
}
