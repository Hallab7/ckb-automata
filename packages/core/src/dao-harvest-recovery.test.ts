import assert from "node:assert/strict";
import test from "node:test";

import { planDaoHarvestRecovery } from "./dao-harvest-recovery.ts";

test("deposited states offer service-independent stop and exit paths", () => {
  for (const condition of [
    "normal",
    "budget_exhausted",
    "deprecated",
    "service_unavailable",
  ] as const) {
    const plan = planDaoHarvestRecovery({ condition, vaultState: "deposited", claimMature: false });
    assert.equal(plan.primaryAction, "start_owner_exit");
    assert.deepEqual(plan.availableActions, ["stop_recurrence", "start_owner_exit"]);
    assert.equal(plan.hostedServicesRequired, false);
  }
});

test("withdrawing states wait until maturity and then allow a direct owner claim", () => {
  const waiting = planDaoHarvestRecovery({
    condition: "service_unavailable",
    vaultState: "withdrawing",
    claimMature: false,
  });
  assert.equal(waiting.primaryAction, "wait_for_maturity");
  const ready = planDaoHarvestRecovery({
    condition: "deprecated",
    vaultState: "withdrawing",
    claimMature: true,
  });
  assert.equal(ready.primaryAction, "claim_mature_vault");
  assert.equal(ready.preservesPrincipal, true);
});
