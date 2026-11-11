import { Suspense } from "react";

import { InlineNotice } from "@ckb-automata/ui";

import { browserWebEnvironment } from "../../../../../src/environment.ts";
import { DaoHarvestV2Setup } from "../../../../../src/setup/dao-harvest-v2-setup.tsx";

export default function NewDaoHarvestV2AutomationPage() {
  if (!browserWebEnvironment().daoHarvestV2SetupEnabled) {
    return (
      <main className="app-page">
        <InlineNotice title="New DAO harvest setup is paused" tone="warning">
          <p>
            Existing automations remain visible and continue to support their valid owner and
            operator actions. New setup will return after the owner exit path is corrected.
          </p>
        </InlineNotice>
      </main>
    );
  }
  return (
    <Suspense fallback={null}>
      <DaoHarvestV2Setup />
    </Suspense>
  );
}
