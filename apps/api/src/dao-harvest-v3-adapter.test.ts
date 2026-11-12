import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveDaoHarvestV3PayloadHash,
  encodeDaoHarvestV3CompensationLockArgs,
  parseHash32,
  scriptIdentityHash,
  type DaoHarvestV3DeploymentIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";
import { DaoHarvestPayloadV3 } from "@ckb-automata/molecule";

import {
  DaoHarvestV3TransactionAdapter,
  daoHarvestV3PolicyScriptHash,
  daoHarvestV3RotationPayload,
  daoHarvestV3SweepAmounts,
  daoHarvestV3TerminalClosePolicyHash,
} from "./dao-harvest-v3-adapter.ts";

const hash = (character: string) => parseHash32(`0x${character.repeat(64)}`);
const point = (character: string) => ({ txHash: hash(character), index: "0x0" as const });
const dependency = (character: string) => ({
  outPoint: point(character),
  depType: "code" as const,
});

test("V3 API derives the full policy script hash rather than using its code hash", () => {
  const script = {
    codeHash: parseHash32(`0x${"1".repeat(64)}`),
    hashType: "data1",
    args: `0x${"2".repeat(64)}`,
  } as const;
  assert.equal(daoHarvestV3PolicyScriptHash(script), scriptIdentityHash(script));
  assert.notEqual(daoHarvestV3PolicyScriptHash(script), script.codeHash);
});

test("V3 policy identity rejects malformed chain scripts", () => {
  assert.throws(
    () =>
      daoHarvestV3PolicyScriptHash({
        codeHash: `0x${"1".repeat(64)}`,
        hashType: "data1",
        args: "not-hex",
      }),
    /canonical CKB script/,
  );
});

test("V3 sweep preserves the reserve and exposes only earned compensation", () => {
  assert.deepEqual(daoHarvestV3SweepAmounts(150n, 100n), { reserve: 100n, payout: 50n });
  assert.throws(() => daoHarvestV3SweepAmounts(100n, 100n), /no earned compensation/);
  assert.throws(() => daoHarvestV3SweepAmounts(99n, 100n), /no earned compensation/);
});

test("V3 rotation changes only operator commitments", () => {
  const payload = DaoHarvestPayloadV3.unpack(
    DaoHarvestPayloadV3.pack({
      version: 3,
      owner_lock_hash: Array(32).fill(1),
      payout_lock_hash: Array(32).fill(2),
      vault_lock_code_hash: Array(32).fill(3),
      compensation_lock_code_hash: Array(32).fill(4),
      dao_type_hash: Array(32).fill(5),
      principal_capacity: "100",
      preferred_prepare_operator_lock_hash: Array(32).fill(6),
      fallback_prepare_executor_set_hash: Array(32).fill(7),
      prepare_service_fee: "8",
      claim_service_fee: "9",
      compensation_seed_capacity: "10",
      prepare_buffer_epochs: "1152921504606846977",
      takeover_delay_epochs: "1152921504606846977",
      confirmation_margin_epochs: "1152921504606846977",
      total_cycles: 2,
      end_epoch_since: "0",
    }),
  );
  const preferred = `0x${"8".repeat(64)}`;
  const fallback = [`0x${"9".repeat(64)}`, `0x${"a".repeat(64)}`];
  const rotation = daoHarvestV3RotationPayload(payload, preferred, fallback);
  const successor = DaoHarvestPayloadV3.unpack(rotation.successorPayload);
  assert.equal(
    Buffer.from(successor.preferred_prepare_operator_lock_hash).toString("hex"),
    preferred.slice(2),
  );
  assert.equal(successor.principal_capacity.toString(), payload.principal_capacity.toString());
  assert.equal(successor.prepare_service_fee.toString(), payload.prepare_service_fee.toString());
  assert.equal(rotation.proof.length, 64);
  assert.throws(
    () => daoHarvestV3RotationPayload(payload, preferred, [fallback[0]!, fallback[0]!]),
    /duplicate identity/,
  );
});

test("V3 terminal close accepts only the manifest-bound terminal compensation cell", () => {
  const deployment = {
    network: "ckb_testnet",
    genesisHash: parseHash32(`0x${"1".repeat(64)}`),
    manifestSha256: "2".repeat(64),
    contracts: {
      jobLock: { codeHash: parseHash32(`0x${"3".repeat(64)}`), cellDep: dependency("3") },
      policy: { codeHash: parseHash32(`0x${"4".repeat(64)}`), cellDep: dependency("4") },
      vaultLock: { codeHash: parseHash32(`0x${"5".repeat(64)}`), cellDep: dependency("5") },
      compensationLock: {
        codeHash: parseHash32(`0x${"6".repeat(64)}`),
        cellDep: dependency("6"),
      },
    },
    secp256k1Blake160: { cellDep: dependency("8") },
    nervosDao: { codeHash: parseHash32(`0x${"7".repeat(64)}`), cellDep: dependency("7") },
  } satisfies DaoHarvestV3DeploymentIdentity;
  const owner = parseHash32(`0x${"8".repeat(64)}`);
  const payout = parseHash32(`0x${"9".repeat(64)}`);
  const payloadBytes = DaoHarvestPayloadV3.pack({
    version: 3,
    owner_lock_hash: [...hexToBytes(owner)],
    payout_lock_hash: [...hexToBytes(payout)],
    vault_lock_code_hash: [...hexToBytes(deployment.contracts.vaultLock.codeHash)],
    compensation_lock_code_hash: [...hexToBytes(deployment.contracts.compensationLock.codeHash)],
    dao_type_hash: Array(32).fill(10),
    principal_capacity: "100",
    preferred_prepare_operator_lock_hash: Array(32).fill(11),
    fallback_prepare_executor_set_hash: Array(32).fill(12),
    prepare_service_fee: "8",
    claim_service_fee: "9",
    compensation_seed_capacity: "10",
    prepare_buffer_epochs: "1152921504606846977",
    takeover_delay_epochs: "1152921504606846977",
    confirmation_margin_epochs: "1152921504606846977",
    total_cycles: 2,
    end_epoch_since: "0",
  });
  const payload = DaoHarvestPayloadV3.unpack(payloadBytes);
  const policyHash = parseHash32(
    scriptToHash({
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1",
      args: deployment.contracts.jobLock.codeHash,
    }),
  );
  const args = {
    jobId: new Uint8Array(32),
    ownerLockHash: hexToBytes(owner),
    payoutLockHash: hexToBytes(payout),
    policyScriptHash: hexToBytes(policyHash),
    payloadHash: deriveDaoHarvestV3PayloadHash(hexToBytes(policyHash), payloadBytes),
  };
  assert.equal(
    daoHarvestV3TerminalClosePolicyHash(payloadBytes, payload, deployment, args, owner),
    policyHash,
  );
  assert.throws(
    () =>
      daoHarvestV3TerminalClosePolicyHash(
        payloadBytes,
        payload,
        deployment,
        { ...args, jobId: hexToBytes(parseHash32(`0x${"f".repeat(64)}`)) },
        owner,
      ),
    /terminal compensation binding/,
  );
  assert.equal(encodeDaoHarvestV3CompensationLockArgs(args).length, 160);
  assert.equal(bytesToHex(args.payloadHash).length, 66);
});

test("V3 setup creates the exact chain-bound state and permits owner wallet funding", async () => {
  const owner = {
    codeHash: hash("a"),
    hashType: "type" as const,
    args: `0x${"12".repeat(20)}` as const,
  };
  const payout = {
    codeHash: hash("a"),
    hashType: "type" as const,
    args: `0x${"34".repeat(20)}` as const,
  };
  const deployment: DaoHarvestV3DeploymentIdentity = {
    network: "ckb_testnet",
    genesisHash: hash("1"),
    manifestSha256: "2".repeat(64),
    contracts: {
      jobLock: { codeHash: hash("3"), cellDep: dependency("3") },
      policy: { codeHash: hash("4"), cellDep: dependency("4") },
      vaultLock: { codeHash: hash("5"), cellDep: dependency("5") },
      compensationLock: { codeHash: hash("6"), cellDep: dependency("6") },
    },
    secp256k1Blake160: { cellDep: dependency("7") },
    nervosDao: { codeHash: hash("8"), cellDep: dependency("8") },
  };
  const chain = {
    getCellLive: async () => ({
      cellOutput: { capacity: 700n * 100_000_000n, lock: owner, type: undefined },
      outputData: { toString: () => "0x" },
    }),
    getTipHeader: async () => ({
      epoch: { integer: 13_920n, numerator: 1_151n, denominator: 1_800n },
      hash: hash("b"),
      number: 22_583_952n,
    }),
    getGenesisHash: async () => deployment.genesisHash,
  };
  const adapter = new DaoHarvestV3TransactionAdapter(chain as never, {} as never, "ckb_testnet", [
    deployment,
  ]);
  const request = {
    creatorNonce: "42",
    identityOutPoint: point("c"),
    ownerLock: owner,
    ownerLockHash: scriptIdentityHash(owner),
    payoutLock: payout,
    payoutLockHash: scriptIdentityHash(payout),
    principal: "24200000000",
    totalCycles: 2,
    preferredOperatorLockHash: hash("d"),
    fallbackOperatorLockHashes: [hash("e")],
  };
  const result = (await adapter.build("setup", request)) as {
    readonly version: number;
    readonly operation: string;
    readonly transaction: UnsignedDeadlineTransaction;
    readonly completion: { readonly requiredInputCapacity: string };
  };
  assert.equal(result.version, 3);
  assert.equal(result.operation, "setup");
  assert.equal(result.transaction.inputs.length, 1);
  assert.equal(result.transaction.outputs.length, 3);
  assert.equal(BigInt(result.transaction.outputs[0]!.capacity), 400n * 100_000_000n);
  assert.equal(BigInt(result.transaction.outputs[1]!.capacity), 242n * 100_000_000n);
  assert.equal(BigInt(result.transaction.outputs[2]!.capacity), 201n * 100_000_000n);
  assert.equal(result.completion.requiredInputCapacity, (700n * 100_000_000n).toString());
  await assert.rejects(
    () => adapter.build("setup", { ...request, ignoredDisplayValue: "not committed" }),
    /unsupported fields/,
  );
});
