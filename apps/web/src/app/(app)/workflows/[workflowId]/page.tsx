import { WorkflowsView } from "@/components/features/workflows/workflows-view";

/** One Workflow, drawn on the canvas. The id is in the URL so a link reopens this pipeline. */
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return <WorkflowsView workflowId={workflowId} />;
}
