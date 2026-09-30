import assert from "node:assert/strict";
import test from "node:test";

import {
  daoHarvestOperationalSignal,
  inspectDaoHarvestDeadLetter,
} from "./dao-harvest-operations.ts";

const deadLetterRecord = (failureCode: string, sourceOperation = "dao-harvest-prepare") => ({
  payload: { failureCode, sourceOperation },
});

test("DAO harvest signals use existing notifications and plain owner guidance", () => {
  const missed = daoHarvestOperationalSignal("prepare_missed");
  assert.equal(missed.notificationType, "failed");
  assert.equal(missed.alertSeverity, "critical");
  assert.match(missed.message, /No funds moved/);

  const exhausted = daoHarvestOperationalSignal("budget_exhausted");
  assert.equal(exhausted.notificationType, "recovery_required");
  assert.equal(exhausted.ownerActionRequired, true);
  assert.match(exhausted.message, /with your wallet/);
});

test("DAO harvest dead letters separate retryable outages from unsafe failures", () => {
  assert.equal(
    inspectDaoHarvestDeadLetter(deadLetterRecord("RPC_UNAVAILABLE")).recommendation,
    "replay",
  );
  assert.equal(
    inspectDaoHarvestDeadLetter(deadLetterRecord("SCRIPT_FAILURE")).recommendation,
    "pause_and_inspect",
  );
  assert.equal(
    inspectDaoHarvestDeadLetter(deadLetterRecord("BUDGET_EXHAUSTED")).recommendation,
    "owner_recovery",
  );
  assert.equal(
    inspectDaoHarvestDeadLetter(deadLetterRecord("RPC_UNAVAILABLE", "evaluate-job")).applies,
    false,
  );
});
