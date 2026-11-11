import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, serializeWitnessArgs } from "@nervosnetwork/ckb-sdk-utils";
import {
  DAO_HARVEST_V3_ABSENT_INDEX,
  hash32ToBytes,
  parseHash32,
  type Hash32,
  type ScriptIdentity,
} from "@ckb-automata/core";
import {
  DaoHarvestEnvelopeV3,
  DaoHarvestPayloadV3,
  DaoHarvestProgressV3,
  DaoHarvestWitnessV3,
  JobDataV1,
} from "@ckb-automata/molecule";
import {
  extractDaoHarvestV3ProjectionEvents,
  rebuildDaoHarvestV3Snapshot,
  type DaoHarvestV3ProjectionDeployment,
} from "./dao-harvest-v3-projection.ts";

const hash = (value: string): Hash32 => parseHash32(`0x${value.repeat(64)}`);
const script = (value: string, args = "0x"): ScriptIdentity => ({
  codeHash: hash(value),
  hashType: "data1",
  args: args as `0x${string}`,
});
const jobId = hash("a");
const owner = hash("b");
const policy = script("d", hash("1"));
const deployment: DaoHarvestV3ProjectionDeployment = {
  networkId: "ckb_testnet",
  jobLock: script("1"),
  policy,
  vaultLock: script("2"),
  compensationLock: script("3"),
};
const payload = DaoHarvestPayloadV3.pack({
  version: 3,
  owner_lock_hash: [...hash32ToBytes(owner)],
  payout_lock_hash: [...hash32ToBytes(hash("c"))],
  vault_lock_code_hash: [...hash32ToBytes(hash("2"))],
  compensation_lock_code_hash: [...hash32ToBytes(hash("3"))],
  dao_type_hash: [...hash32ToBytes(hash("e"))],
  principal_capacity: "1000",
  preferred_prepare_operator_lock_hash: [...hash32ToBytes(hash("5"))],
  fallback_prepare_executor_set_hash: [...hash32ToBytes(hash("4"))],
  prepare_service_fee: "10",
  claim_service_fee: "20",
  compensation_seed_capacity: "200",
  prepare_buffer_epochs: "1152921504606846977",
  takeover_delay_epochs: "1152921504606846977",
  confirmation_margin_epochs: "1152921504606846977",
  total_cycles: 2,
  end_epoch_since: "0",
});
const progress = DaoHarvestProgressV3.pack({
  version: 3,
  state: 0,
  cycle_index: 0,
  prepare_credit_hash: Array(32).fill(0),
});
const job = JobDataV1.pack({
  version: 1,
  flags: 0,
  job_id: [...hash32ToBytes(jobId)],
  sequence: "0",
  state: 0,
  trigger_kind: 2,
  trigger_params_hash: [...hash32ToBytes(hash("8"))],
  policy_script_hash: [...hash32ToBytes(hash("9"))],
  payload_hash: [...hash32ToBytes(hash("7"))],
  reward: "0",
  remaining_budget: "0",
  not_before: "1",
  not_after: "0",
  remaining_runs: 2,
  cancel_lock_hash: [...hash32ToBytes(owner)],
});

function setupBlock() {
  const witness = DaoHarvestWitnessV3.pack({
    version: 3,
    operation: 0,
    flags: 0,
    job_input_index: DAO_HARVEST_V3_ABSENT_INDEX,
    vault_input_index: DAO_HARVEST_V3_ABSENT_INDEX,
    compensation_input_index: DAO_HARVEST_V3_ABSENT_INDEX,
    identity_input_index: 0,
    prepare_accumulator_input_index: DAO_HARVEST_V3_ABSENT_INDEX,
    claim_accumulator_input_index: DAO_HARVEST_V3_ABSENT_INDEX,
    job_output_index: 0,
    vault_output_index: 1,
    compensation_output_index: 2,
    prepare_accumulator_output_index: DAO_HARVEST_V3_ABSENT_INDEX,
    claim_accumulator_output_index: DAO_HARVEST_V3_ABSENT_INDEX,
    payload_hash: [...hash32ToBytes(hash("7"))],
    progress_hash: [...hash32ToBytes(hash("8"))],
    prepare_credit_hash: Array(32).fill(0),
  });
  const envelope = DaoHarvestEnvelopeV3.pack({
    payload: [...payload],
    progress: [...progress],
    prepare_credit: [],
    operator_proof: [...hash32ToBytes(hash("4"))],
    successor_payload: [],
  });
  const compensationArgs = new Uint8Array(160);
  compensationArgs.set(hash32ToBytes(jobId));
  const txHash = hash("f");
  return {
    txHash,
    block: {
      header: { hash: hash("6"), number: "0x64" },
      transactions: [
        {
          hash: () => txHash,
          inputs: [{ previousOutput: { txHash: hash("0"), index: "0x0" } }],
          outputs: [
            { capacity: "0x64", lock: script("1"), type: policy },
            { capacity: "0x3e8", lock: script("2"), type: script("e") },
            { capacity: "0xc8", lock: script("3", bytesToHex(compensationArgs)), type: undefined },
          ],
          outputsData: [bytesToHex(job), "0x0000000000000000", "0x"],
          witnesses: [
            serializeWitnessArgs({
              lock: "",
              inputType: bytesToHex(witness),
              outputType: bytesToHex(envelope),
            }),
          ],
        },
      ],
    },
  };
}

test("extracts a canonical V3 setup and rebuilds it without database history", () => {
  const setup = setupBlock();
  const result = extractDaoHarvestV3ProjectionEvents(setup.block as never, deployment);
  assert.equal(result.malformed, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.operation, "setup");
  assert.equal(result.events[0]?.jobId, jobId);
  assert.equal(result.events[0]?.lifecycleState, "deposited");
  assert.equal(result.events[0]?.payload, bytesToHex(payload));
  assert.equal(result.events[0]?.progress, bytesToHex(progress));
  assert.equal(result.events[0]?.prepareCreditBytes, null);
  assert.equal(result.events[0]?.prepareAccumulatorOutPoint, null);
  assert.equal(result.events[0]?.claimAccumulatorOutPoint, null);
  assert.equal(rebuildDaoHarvestV3Snapshot(result.events)?.transactionHash, setup.txHash);
});

test("an orphaned V3 event is excluded from deterministic rebuild", () => {
  const event = extractDaoHarvestV3ProjectionEvents(setupBlock().block as never, deployment)
    .events[0]!;
  assert.equal(rebuildDaoHarvestV3Snapshot([{ ...event, canonical: false }]), null);
});

test("another deployment revision does not decode the same transaction", () => {
  const result = extractDaoHarvestV3ProjectionEvents(setupBlock().block as never, {
    ...deployment,
    policy: script("0"),
    compensationLock: script("9"),
  });
  assert.deepEqual(result, { events: [], malformed: 0 });
});
