import { ScaffoldPage } from "../../../../src/scaffold/scaffold-page.tsx";

export default async function AutomationPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  return <ScaffoldPage detail={jobId} title="Automation" />;
}
