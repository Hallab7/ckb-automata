import assert from "node:assert/strict";
import test from "node:test";

import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  DaoHarvestEnvelopeV3,
  DaoHarvestPayloadV3,
  DaoHarvestProgressV3,
  JobDataV1,
} from "@ckb-automata/molecule";

import { parseHash32, type Hash32 } from "./chain-values.ts";
import {
  buildDaoHarvestV3ClaimTransition,
  buildDaoHarvestV3PrepareTransition,
  type DaoHarvestV3TransitionCell,
  type DaoHarvestV3TransitionDeployment,
} from "./dao-harvest-v3-transitions.ts";
import {
  deriveDaoHarvestV3FallbackOperatorSetHash,
  deriveDaoHarvestV3PayloadHash,
  deriveDaoHarvestV3PrepareCreditHash,
  deriveDaoHarvestV3ProgressHash,
  encodeDaoHarvestV3CompensationLockArgs,
  encodeDaoHarvestV3FallbackOperatorProof,
  encodeDaoHarvestV3VaultLockArgs,
} from "./dao-harvest-v3.ts";
import type { ScriptIdentity } from "./job-inspection.ts";

const CKB = 100_000_000n;
const hash = (digit: string): Hash32 => parseHash32(`0x${digit.repeat(64)}`);
const script = (digit: string, args: `0x${string}` = "0x"): ScriptIdentity =>
  Object.freeze({ codeHash: hash(digit), hashType: "data1" as const, args });
const point = (digit: string, index = 0n) => Object.freeze({ txHash: hash(digit), index });
const dep = (digit: string) =>
  Object.freeze({
    outPoint: Object.freeze({ txHash: hash(digit), index: "0x0" as const }),
    depType: "code" as const,
  });

const jobLock = script("1");
const policy = script("2", hash("1") as `0x${string}`);
const daoType = Object.freeze({
  codeHash: hash("3"),
  hashType: "type" as const,
  args: "0x" as const,
});
const ownerLock = Object.freeze({
  codeHash: hash("4"),
  hashType: "type" as const,
  args: "0x1234" as const,
});
const policyHash = parseHash32(scriptToHash(policy));
const ownerHash = parseHash32(scriptToHash(ownerLock));
const accumulatorLock = script(
  "6",
  bytesToHex(
    Uint8Array.from([...hexToBytes(ownerHash), ...hexToBytes(policyHash)]),
  ) as `0x${string}`,
);
const fallback = [hexToBytes(ownerHash)];
const proof = encodeDaoHarvestV3FallbackOperatorProof(fallback);
const deployment: DaoHarvestV3TransitionDeployment = Object.freeze({
  network: "ckb_testnet",
  genesisHash: hash("a"),
  manifestSha256: "b".repeat(64),
  secp256k1Blake160: { cellDep: dep("a") },
  nervosDao: { codeHash: daoType.codeHash, cellDep: dep("b") },
  contracts: {
    jobLock: { codeHash: jobLock.codeHash, cellDep: dep("1") },
    policy: { codeHash: policy.codeHash, cellDep: dep("2") },
    vaultLock: { codeHash: hash("5"), cellDep: dep("5") },
    compensationLock: { codeHash: hash("6"), cellDep: dep("6") },
  },
});

const payload = DaoHarvestPayloadV3.pack({
  version: 3,
  owner_lock_hash: [...hexToBytes(ownerHash)],
  payout_lock_hash: [...hexToBytes(hash("7"))],
  vault_lock_code_hash: [...hexToBytes(hash("5"))],
  compensation_lock_code_hash: [...hexToBytes(hash("6"))],
  dao_type_hash: [...hexToBytes(parseHash32(scriptToHash(daoType)))],
  principal_capacity: (10_000n * CKB).toString(),
  preferred_prepare_operator_lock_hash: [...hexToBytes(ownerHash)],
  fallback_prepare_executor_set_hash: [...deriveDaoHarvestV3FallbackOperatorSetHash(fallback)],
  prepare_service_fee: (2n * CKB).toString(),
  claim_service_fee: (3n * CKB).toString(),
  compensation_seed_capacity: (201n * CKB).toString(),
  prepare_buffer_epochs: ((1n << 63n) | (1n << 61n) | 4n).toString(),
  takeover_delay_epochs: ((1n << 63n) | (1n << 61n) | 1n).toString(),
  confirmation_margin_epochs: ((1n << 63n) | (1n << 61n) | 1n).toString(),
  total_cycles: 2,
  end_epoch_since: "0",
});
const deposited = DaoHarvestProgressV3.pack({
  version: 3,
  state: 0,
  cycle_index: 0,
  prepare_credit_hash: Array(32).fill(0),
});
const jobId = hash("8");
const vaultLock = script(
  "5",
  bytesToHex(
    encodeDaoHarvestV3VaultLockArgs({
      jobId: hexToBytes(jobId),
      ownerLockHash: hexToBytes(ownerHash),
      jobLockHash: hexToBytes(parseHash32(scriptToHash(jobLock))),
      policyScriptHash: hexToBytes(policyHash),
      immutableTermsHash: hexToBytes(hash("9")),
    }),
  ) as `0x${string}`,
);
const compensationLock = script(
  "6",
  bytesToHex(
    encodeDaoHarvestV3CompensationLockArgs({
      jobId: hexToBytes(jobId),
      ownerLockHash: hexToBytes(ownerHash),
      payoutLockHash: hexToBytes(hash("7")),
      policyScriptHash: hexToBytes(policyHash),
      payloadHash: deriveDaoHarvestV3PayloadHash(hexToBytes(policyHash), payload),
    }),
  ) as `0x${string}`,
);

function cell(
  digit: string,
  capacity: bigint,
  lock: ScriptIdentity,
  type: ScriptIdentity | null,
  data: `0x${string}`,
): DaoHarvestV3TransitionCell {
  return Object.freeze({ outPoint: point(digit), capacity, lock, type, data });
}

const jobData = JobDataV1.pack({
  version: 1,
  flags: 0,
  job_id: [...hexToBytes(jobId)],
  sequence: "0",
  state: 0,
  trigger_kind: 2,
  trigger_params_hash: [...deriveDaoHarvestV3ProgressHash(deposited)],
  policy_script_hash: [...hexToBytes(policyHash)],
  payload_hash: [...deriveDaoHarvestV3PayloadHash(hexToBytes(policyHash), payload)],
  reward: "0",
  remaining_budget: "0",
  not_before: ((1n << 61n) | 100n).toString(),
  not_after: "0",
  remaining_runs: 2,
  cancel_lock_hash: [...hexToBytes(ownerHash)],
});

function prepareInput() {
  return {
    deployment,
    policyScriptHash: policyHash,
    payload,
    progress: deposited,
    job: cell("a", 400n * CKB, jobLock, policy, bytesToHex(jobData) as `0x${string}`),
    vault: cell("b", 10_000n * CKB, vaultLock, daoType, "0x0000000000000000"),
    accumulator: cell("c", 300n * CKB, accumulatorLock, null, "0x"),
    feeCell: cell("d", 100n * CKB, ownerLock, null, "0x"),
    operatorOwnerLock: ownerLock,
    transactionFee: 50_000n,
    rpcGenesisHash: deployment.genesisHash,
    canonicalHeaderHashes: [hash("d"), hash("e")],
    ownerLock,
    operation: "preferred_prepare" as const,
    depositHeaderHash: hash("d"),
    depositBlockNumber: 10n,
    executionSince: (1n << 61n) | 100n,
    claimSince: (1n << 61n) | 104n,
  };
}

function witnessOutputType(value: `0x${string}`): Uint8Array {
  const bytes = hexToBytes(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const outputOffset = view.getUint32(12, true);
  const length = view.getUint32(outputOffset, true);
  return bytes.slice(outputOffset + 4, outputOffset + 4 + length);
}

test("V3 transition builders produce committed prepare and claim successors", () => {
  const prepared = buildDaoHarvestV3PrepareTransition(prepareInput());
  assert.equal(prepared.transaction.inputs.length, 4);
  assert.equal(prepared.transaction.outputs.length, 4);
  const envelope = DaoHarvestEnvelopeV3.unpack(
    witnessOutputType(prepared.transaction.witnesses[0]!),
  );
  const credit = Uint8Array.from(envelope.prepare_credit);
  assert(credit.length > 0);

  const claimJob = cell("e", 400n * CKB, jobLock, policy, prepared.transaction.outputsData[0]!);
  const claimVault = cell(
    "f",
    10_000n * CKB,
    vaultLock,
    daoType,
    prepared.transaction.outputsData[1]!,
  );
  const withdrawing = DaoHarvestProgressV3.pack({
    version: 3,
    state: 1,
    cycle_index: 0,
    prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(credit)],
  });
  const claimed = buildDaoHarvestV3ClaimTransition({
    ...prepareInput(),
    operation: "preferred_claim",
    progress: withdrawing,
    job: claimJob,
    vault: claimVault,
    compensation: cell("1", 201n * CKB, compensationLock, null, "0x"),
    prepareAccumulator: cell("2", 300n * CKB, accumulatorLock, null, "0x"),
    prepareCredit: credit,
    depositHeaderHash: hash("d"),
    prepareHeaderHash: hash("e"),
    depositAccumulatedRate: 10_000_000_000_000_000n,
    prepareAccumulatedRate: 10_010_000_000_000_000n,
    vaultOccupiedCapacity: 242n * CKB,
    executionSince: (1n << 61n) | 104n,
    nextPrepareSince: (1n << 61n) | 200n,
  });
  assert.equal(claimed.transaction.outputs.length, 5);
  assert.equal(BigInt(claimed.transaction.outputs[0]!.capacity), 400n * CKB);
  assert.equal(claimed.transaction.outputsData[1], "0x0000000000000000");
});

test("owner completion waives claim payment and uses the owner as the claim authority", () => {
  const prepared = buildDaoHarvestV3PrepareTransition(prepareInput());
  const envelope = DaoHarvestEnvelopeV3.unpack(
    witnessOutputType(prepared.transaction.witnesses[0]!),
  );
  const credit = Uint8Array.from(envelope.prepare_credit);
  const withdrawing = DaoHarvestProgressV3.pack({
    version: 3,
    state: 1,
    cycle_index: 0,
    prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(credit)],
  });
  const compensationCapacity = 201n * CKB;
  const completed = buildDaoHarvestV3ClaimTransition({
    ...prepareInput(),
    operation: "owner_complete",
    progress: withdrawing,
    job: cell("e", 400n * CKB, jobLock, policy, prepared.transaction.outputsData[0]!),
    vault: cell("f", 10_000n * CKB, vaultLock, daoType, prepared.transaction.outputsData[1]!),
    compensation: cell("1", compensationCapacity, compensationLock, null, "0x"),
    prepareAccumulator: cell("2", 300n * CKB, accumulatorLock, null, "0x"),
    prepareCredit: credit,
    depositHeaderHash: hash("d"),
    prepareHeaderHash: hash("e"),
    depositAccumulatedRate: 10_000_000_000_000_000n,
    prepareAccumulatedRate: 10_010_000_000_000_000n,
    vaultOccupiedCapacity: 242n * CKB,
    executionSince: (1n << 61n) | 104n,
    nextPrepareSince: (1n << 61n) | 200n,
  });
  assert.equal(completed.operation, 5);
  assert.equal(completed.transaction.inputs.length, 5);
  assert.equal(completed.transaction.outputs.length, 5);
  assert(BigInt(completed.transaction.outputs[2]!.capacity) > compensationCapacity);
  assert.equal(scriptToHash(completed.transaction.outputs[4]!.lock), scriptToHash(ownerLock));
});

test("V3 transition builders fail closed on payload substitution and missing fallback proof", () => {
  const changedPayload = Uint8Array.from(payload);
  changedPayload[changedPayload.length - 1] = changedPayload.at(-1)! ^ 1;
  assert.throws(
    () => buildDaoHarvestV3PrepareTransition({ ...prepareInput(), payload: changedPayload }),
    /does not commit to the supplied V3 payload/,
  );
  assert.throws(
    () =>
      buildDaoHarvestV3PrepareTransition({
        ...prepareInput(),
        operation: "fallback_prepare",
      }),
    /requires the committed operator proof/,
  );
  assert.doesNotThrow(() =>
    buildDaoHarvestV3PrepareTransition({
      ...prepareInput(),
      operation: "fallback_prepare",
      operatorProof: proof,
    }),
  );
});

test("the final V3 claim returns principal to an ordinary owner DAO deposit", () => {
  const prepared = buildDaoHarvestV3PrepareTransition(prepareInput());
  const envelope = DaoHarvestEnvelopeV3.unpack(
    witnessOutputType(prepared.transaction.witnesses[0]!),
  );
  const credit = Uint8Array.from(envelope.prepare_credit);
  const preparedJob = JobDataV1.unpack(hexToBytes(prepared.transaction.outputsData[0]!));
  const terminalJob = JobDataV1.pack({ ...preparedJob, remaining_runs: 1 });
  const withdrawing = DaoHarvestProgressV3.pack({
    version: 3,
    state: 1,
    cycle_index: 0,
    prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(credit)],
  });
  const claimed = buildDaoHarvestV3ClaimTransition({
    ...prepareInput(),
    operation: "preferred_claim",
    progress: withdrawing,
    job: cell("e", 400n * CKB, jobLock, policy, bytesToHex(terminalJob) as `0x${string}`),
    vault: cell("f", 10_000n * CKB, vaultLock, daoType, prepared.transaction.outputsData[1]!),
    compensation: cell("1", 201n * CKB, compensationLock, null, "0x"),
    prepareAccumulator: cell("2", 300n * CKB, accumulatorLock, null, "0x"),
    prepareCredit: credit,
    depositHeaderHash: hash("d"),
    prepareHeaderHash: hash("e"),
    depositAccumulatedRate: 10_000_000_000_000_000n,
    prepareAccumulatedRate: 10_010_000_000_000_000n,
    vaultOccupiedCapacity: 242n * CKB,
    executionSince: (1n << 61n) | 104n,
  });
  assert.equal(claimed.transaction.outputs.length, 4);
  assert.equal(scriptToHash(claimed.transaction.outputs[0]!.lock), scriptToHash(ownerLock));
  assert.equal(claimed.transaction.outputsData[0], "0x0000000000000000");
  assert.notEqual(claimed.transaction.witnesses[1], "0x");
});
