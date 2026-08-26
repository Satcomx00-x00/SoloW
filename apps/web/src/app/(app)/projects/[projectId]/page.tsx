import { Suspense } from "react";
import { ProjectView } from "@/components/features/project/project-view";

/**
 * One Project's planning table (spec F23).
 *
 * The Suspense boundary is what `useSearchParams` needs in the App Router — the active view and
 * its filter live in the query so a narrowed tab is shareable (F23 issue #129, AC-7), while the
 * Project itself lives in the path.
 */
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <Suspense fallback={null}>
      <ProjectView projectId={projectId} />
    </Suspense>
  );
}
