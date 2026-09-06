import { WorkflowsView } from "@/components/features/workflows/workflows-view";

/**
 * The Workflow designer with nothing selected.
 *
 * A top-level route, not `/projects/:id/workflows`: a Workflow belongs to the Workspace and
 * names no Project (see `WORKSPACE_SECTIONS` in `@/lib/navigation`).
 */
export default function WorkflowsPage() {
  return <WorkflowsView />;
}
