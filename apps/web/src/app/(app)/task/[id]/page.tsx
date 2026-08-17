import { TaskWorkspace } from "@/components/features/task/task-workspace";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskWorkspace taskId={id} />;
}
