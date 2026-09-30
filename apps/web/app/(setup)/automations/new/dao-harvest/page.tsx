import { Suspense } from "react";

import { DaoHarvestSetup } from "../../../../../src/setup/dao-harvest-setup.tsx";

export default function NewDaoHarvestAutomationPage() {
  return (
    <Suspense fallback={null}>
      <DaoHarvestSetup />
    </Suspense>
  );
}
