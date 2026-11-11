import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";
import {
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
} from "@ckb-automata/molecule";
import { parseHash32 } from "./chain-values.ts";
import type { UnsignedCellOutput } from "./deadline-creation.ts";
import type { ScriptIdentity } from "./job-inspection.ts";
import {
  buildDaoHarvestV3Close,
  buildDaoHarvestV3FallbackClaim,
  buildDaoHarvestV3FallbackPrepare,
  buildDaoHarvestV3OwnerCompletion,
  buildDaoHarvestV3OwnerExit,
  buildDaoHarvestV3OwnerRecovery,
  buildDaoHarvestV3PreferredClaim,
  buildDaoHarvestV3PreferredPrepare,
  buildDaoHarvestV3Rotation,
  buildDaoHarvestV3Setup,
  buildDaoHarvestV3Sweep,
  verifyCompletedDaoHarvestV3Transaction,
  type DaoHarvestV3BuildInput,
  type DaoHarvestV3NamedInputs,
  type DaoHarvestV3NamedOutputs,
  type DaoHarvestV3ReviewedInput,
  type DaoHarvestV3ReviewedOutput,
} from "./dao-harvest-v3-builders.ts";
import { deriveDaoHarvestV3PrepareCreditHash } from "./dao-harvest-v3.ts";

const hash = (character: string) => parseHash32(`0x${character.repeat(64)}`);
const hashBytes = (character: string) => [...Buffer.from(hash(character).slice(2), "hex")];
const lock = (character: string): ScriptIdentity => ({
  codeHash: hash(character),
  hashType: "type",
  args: "0x",
});
const dep = (character: string) => ({
  outPoint: { txHash: hash(character), index: "0x0" as const },
  depType: "code" as const,
});
const owner = hash("1");
const policy = hash("2");
const payload = DaoHarvestPayloadV3.pack({
  version: 3,
  owner_lock_hash: [...Buffer.from(owner.slice(2), "hex")],
  payout_lock_hash: hashBytes("3"),
  vault_lock_code_hash: hashBytes("4"),
  compensation_lock_code_hash: hashBytes("5"),
  dao_type_hash: [...Buffer.from(scriptToHash(lock("6")).slice(2), "hex")],
  principal_capacity: "10000000000",
  preferred_prepare_operator_lock_hash: Array(32).fill(7),
  fallback_prepare_executor_set_hash: Array(32).fill(8),
  prepare_service_fee: "10",
  claim_service_fee: "10",
  compensation_seed_capacity: "100",
  prepare_buffer_epochs: "1152921504606846977",
  takeover_delay_epochs: "1152921504606846977",
  confirmation_margin_epochs: "1152921504606846977",
  total_cycles: 1,
  end_epoch_since: "0",
});
const progress = DaoHarvestProgressV3.pack({
  version: 3,
  state: 0,
  cycle_index: 0,
  prepare_credit_hash: Array(32).fill(0),
});
const credit = DaoHarvestPrepareCreditV3.pack({
  version: 3,
  job_id: Array(32).fill(9),
  cycle_index: 0,
  preparer_lock_hash: Array(32).fill(10),
  prepared_vault_output_index: 1,
  job_output_index: 0,
});

let sequence = 0;
function reviewedInput(name: string): DaoHarvestV3ReviewedInput {
  sequence += 1;
  return {
    input: {
      since: "0x0",
      previousOutput: {
        txHash: hash(((sequence % 6) + 9).toString(16)),
        index: `0x${sequence.toString(16)}`,
      },
    },
    capacity: 1_000_000n,
    lockHash: hash(name),
  };
}
function reviewedOutput(character: string): DaoHarvestV3ReviewedOutput {
  const output: UnsignedCellOutput = { capacity: "0x186a0", lock: lock(character), type: null };
  return { output, data: "0x" };
}

function roles(operation: number): {
  inputs: DaoHarvestV3NamedInputs;
  outputs: DaoHarvestV3NamedOutputs;
} {
  const identity = reviewedInput("1");
  const job = reviewedInput("2");
  const vault = reviewedInput("3");
  const compensation = reviewedInput("4");
  const prepareAccumulator = reviewedInput("5");
  const claimAccumulator = reviewedInput("6");
  const inputMap: Record<number, DaoHarvestV3NamedInputs> = {
    0: { identity },
    1: { job, vault, identity, prepareAccumulator },
    2: { job, vault, identity, prepareAccumulator },
    3: { job, vault, compensation, identity, prepareAccumulator },
    4: { job, vault, compensation, identity, prepareAccumulator, claimAccumulator },
    5: { job, vault, compensation, identity, prepareAccumulator },
    6: { job, compensation, identity },
    7: { compensation, identity },
    8: { job, compensation, identity },
    9: { job, vault, compensation, identity },
    10: { job, vault, compensation, identity, prepareAccumulator },
  };
  const outputMap: Record<number, DaoHarvestV3NamedOutputs> = {
    0: { job: reviewedOutput("2"), vault: reviewedOutput("3"), compensation: reviewedOutput("4") },
    1: {
      job: reviewedOutput("2"),
      vault: reviewedOutput("3"),
      prepareAccumulator: reviewedOutput("5"),
    },
    2: {
      job: reviewedOutput("2"),
      vault: reviewedOutput("3"),
      prepareAccumulator: reviewedOutput("5"),
    },
    3: {
      vault: reviewedOutput("3"),
      compensation: reviewedOutput("4"),
      prepareAccumulator: reviewedOutput("5"),
    },
    4: {
      vault: reviewedOutput("3"),
      compensation: reviewedOutput("4"),
      prepareAccumulator: reviewedOutput("5"),
      claimAccumulator: reviewedOutput("6"),
    },
    5: {
      vault: reviewedOutput("3"),
      compensation: reviewedOutput("4"),
      prepareAccumulator: reviewedOutput("5"),
    },
    6: { job: reviewedOutput("2"), compensation: reviewedOutput("4") },
    7: {},
    8: { job: reviewedOutput("2"), compensation: reviewedOutput("4") },
    9: { vault: reviewedOutput("1"), additional: [reviewedOutput("1")] },
    10: { prepareAccumulator: reviewedOutput("5"), additional: [reviewedOutput("1")] },
  };
  return { inputs: inputMap[operation]!, outputs: outputMap[operation]! };
}

function fixture(operation: number): DaoHarvestV3BuildInput {
  const selected = roles(operation);
  const all = [
    selected.inputs.job,
    selected.inputs.vault,
    selected.inputs.compensation,
    selected.inputs.identity,
    selected.inputs.prepareAccumulator,
    selected.inputs.claimAccumulator,
  ].filter((item): item is DaoHarvestV3ReviewedInput => item !== undefined);
  return {
    context: {
      rpcGenesisHash: hash("a"),
      canonicalHeaderHashes: [],
      signerLockHash: owner,
      liveOutPoints: all.map((item) => item.input.previousOutput),
      deployment: {
        network: "ckb_testnet",
        genesisHash: hash("a"),
        manifestSha256: "b".repeat(64),
        secp256k1Blake160: { cellDep: dep("1") },
        nervosDao: { codeHash: hash("6"), cellDep: dep("7") },
        contracts: {
          jobLock: { codeHash: hash("2"), cellDep: dep("2") },
          policy: { codeHash: hash("3"), cellDep: dep("3") },
          vaultLock: { codeHash: hash("4"), cellDep: dep("4") },
          compensationLock: { codeHash: hash("5"), cellDep: dep("5") },
        },
      },
    },
    policyScriptHash: policy,
    ownerLockHash: owner,
    payload,
    progress: [3, 4, 5, 10].includes(operation)
      ? DaoHarvestProgressV3.pack({
          version: 3,
          state: 1,
          cycle_index: 0,
          prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(credit)],
        })
      : progress,
    ...([1, 2, 3, 4, 5, 10].includes(operation) ? { prepareCredit: credit } : {}),
    ...([0, 2, 8].includes(operation) ? { operatorProof: Uint8Array.from(Array(32).fill(8)) } : {}),
    ...(operation === 8 ? { successorPayload: payload } : {}),
    inputs: selected.inputs,
    outputs: selected.outputs,
    maximumNetworkFee: 10_000_000n,
    allowedFundingLockHashes: [owner],
  };
}

test("typed V3 builders derive every closed witness layout", () => {
  const builders = [
    buildDaoHarvestV3Setup,
    buildDaoHarvestV3PreferredPrepare,
    buildDaoHarvestV3FallbackPrepare,
    buildDaoHarvestV3PreferredClaim,
    buildDaoHarvestV3FallbackClaim,
    buildDaoHarvestV3OwnerCompletion,
    buildDaoHarvestV3Sweep,
    buildDaoHarvestV3Close,
    buildDaoHarvestV3Rotation,
    buildDaoHarvestV3OwnerExit,
    buildDaoHarvestV3OwnerRecovery,
  ];
  builders.forEach((builder, operation) =>
    assert.equal(builder(fixture(operation)).operation, operation),
  );
});

test("one operator accumulator may satisfy both identity and prepare roles", () => {
  const input = fixture(1);
  const accumulator = input.inputs.prepareAccumulator!;
  const build = buildDaoHarvestV3PreferredPrepare({
    ...input,
    inputs: { ...input.inputs, identity: accumulator },
  });
  assert.equal(build.transaction.inputs.length, 3);
  assert.doesNotThrow(() => verifyCompletedDaoHarvestV3Transaction(build, build.transaction, []));
});

test("owner exit protects the real DAO same-index output during wallet completion", () => {
  const build = buildDaoHarvestV3OwnerExit(fixture(9));
  assert.equal(build.completion.protectedSameIndex, 1);
  assert.doesNotThrow(() => verifyCompletedDaoHarvestV3Transaction(build, build.transaction, []));
  const outputs = [...build.transaction.outputs];
  outputs[1] = { ...outputs[1]!, capacity: "0x1" };
  assert.throws(
    () => verifyCompletedDaoHarvestV3Transaction(build, { ...build.transaction, outputs }, []),
    /reviewed output 1|same-index/,
  );
});

test("wallet completion permits only signatures and reviewed change locks", () => {
  const build = buildDaoHarvestV3OwnerExit(fixture(9));
  const raw = hexToBytes(build.transaction.witnesses[0]!);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const second = view.getUint32(8, true);
  const third = view.getUint32(12, true);
  const field = (start: number, end: number) =>
    bytesToHex(raw.slice(start + 4, end)) as `0x${string}`;
  const signed = serializeWitnessArgs({
    lock: "0x1234",
    inputType: field(second, third),
    outputType: field(third, raw.length),
  }) as `0x${string}`;
  const signedTransaction = {
    ...build.transaction,
    witnesses: [signed, ...build.transaction.witnesses.slice(1)],
  };
  assert.doesNotThrow(() => verifyCompletedDaoHarvestV3Transaction(build, signedTransaction, []));
  assert.throws(
    () =>
      verifyCompletedDaoHarvestV3Transaction(
        build,
        {
          ...signedTransaction,
          outputs: [...signedTransaction.outputs, { capacity: "0x1", lock: lock("f"), type: null }],
          outputsData: [...signedTransaction.outputsData, "0x"],
        },
        [],
      ),
    /unreviewed change/,
  );
});

test("chain context fails closed for stale cells, wrong network, and another signer", () => {
  const input = fixture(9);
  assert.throws(
    () =>
      buildDaoHarvestV3OwnerExit({ ...input, context: { ...input.context, liveOutPoints: [] } }),
    /stale/,
  );
  assert.throws(
    () =>
      buildDaoHarvestV3OwnerExit({
        ...input,
        context: { ...input.context, rpcGenesisHash: hash("f") },
      }),
    /genesis/,
  );
  assert.throws(
    () =>
      buildDaoHarvestV3OwnerExit({
        ...input,
        context: { ...input.context, signerLockHash: hash("f") },
      }),
    /committed owner/,
  );
});
