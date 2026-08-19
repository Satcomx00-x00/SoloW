import { IssueDetail } from "@/components/features/issues/issue-detail";

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IssueDetail issueId={id} />;
}
