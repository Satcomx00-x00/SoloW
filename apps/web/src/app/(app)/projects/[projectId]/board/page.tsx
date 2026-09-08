import { Suspense } from "react";
import { Board } from "@/components/features/board/board";

/**
 * One Project's board.
 *
 * The board owns the full height of the main pane so its columns can too: a kanban column that
 * stops where its cards stop leaves a dead field underneath and gives a drag nowhere to land.
 * Its create actions live in the shell header, not a band of their own beneath it.
 *
 * The Suspense boundary is what `useSearchParams` needs in the App Router (same reason
 * `project-view.tsx`'s route needs one) — the board reads `?column=` to scroll to the lifecycle
 * column the sidebar linked to.
 */
export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense fallback={null}>
        <Board projectId={projectId} />
      </Suspense>
    </div>
  );
}
