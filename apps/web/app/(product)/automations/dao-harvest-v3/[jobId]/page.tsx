import { DaoHarvestV3Detail } from "../../../../../src/dao-harvest/dao-harvest-v3-detail.tsx";

export default async function DaoHarvestV3AutomationPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  return <DaoHarvestV3Detail jobId={jobId} />;
}
