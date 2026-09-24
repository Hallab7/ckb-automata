import { AutomationDetail } from "../../../../src/detail/job-detail.tsx";

export default async function AutomationPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  return <AutomationDetail jobId={jobId} />;
}
