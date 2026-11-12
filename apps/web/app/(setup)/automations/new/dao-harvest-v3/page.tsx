import { Suspense } from "react";

import { InlineNotice } from "@ckb-automata/ui";

import { browserWebEnvironment } from "../../../../../src/environment.ts";
import { DaoHarvestV3Setup } from "../../../../../src/setup/dao-harvest-v2-setup.tsx";

export default function NewDaoHarvestV3AutomationPage() {
  if (!browserWebEnvironment().daoHarvestV3SetupEnabled) {
    return (
      <main className="app-page">
        <InlineNotice title="DAO Harvest V3 is not available yet" tone="warning">
          <p>
            The testnet contracts, public evidence, and independent security review must be complete
            before new V3 deposits are enabled.
          </p>
        </InlineNotice>
      </main>
    );
  }
  return (
    <Suspense fallback={null}>
      <DaoHarvestV3Setup />
    </Suspense>
  );
}
