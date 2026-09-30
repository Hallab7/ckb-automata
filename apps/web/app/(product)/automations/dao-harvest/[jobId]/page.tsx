import { DaoHarvestDetail } from "../../../../../src/dao-harvest/dao-harvest-detail.tsx";

export default async function DaoHarvestAutomationPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  return <DaoHarvestDetail jobId={jobId} />;
}
