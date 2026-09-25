import assert from "node:assert/strict";
import test from "node:test";

import { WitnessArgs, type ClientBlock } from "@ckb-ccc/shell";

import { deploymentRegistry } from "@ckb-automata/core";

import {
  classifyJobTransition,
  executorLockHashFromWitness,
  JobTransitionIndexer,
} from "./job-transitions.ts";

function witness(inputType: `0x${string}`): string {
  return WitnessArgs.from({ inputType }).toHex();
}

const execute = witness(`0x00${"00000000"}${"11".repeat(32)}01${"00000000"}`);

test("classifies one-shot and recurring execution from successor presence", () => {
  assert.equal(classifyJobTransition(execute, false), "one_shot");
  assert.equal(classifyJobTransition(execute, true), "recurring");
  assert.equal(executorLockHashFromWitness(execute), `0x${"11".repeat(32)}`);
});

test("classifies cancellation, recovery, and top-up witness modes", () => {
  assert.equal(classifyJobTransition(witness("0x01"), false), "cancelled");
  assert.equal(classifyJobTransition(witness("0x02"), false), "recovered");
  assert.equal(classifyJobTransition(witness("0x0300000000"), true), "topped_up");
});

test("records malformed and contradictory consumption as consumed by other", () => {
  assert.equal(classifyJobTransition("0x", false), "consumed_by_other");
  assert.equal(executorLockHashFromWitness("0x"), undefined);
  assert.equal(classifyJobTransition(witness("0x01"), true), "consumed_by_other");
  assert.equal(classifyJobTransition(witness("0x0300000000"), false), "consumed_by_other");
});

test("skips transactional input scans when no live Job Cell can be consumed", async () => {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  let transactionCalled = false;
  let selectCalled = false;
  const database = {
    select: () => ({
      from: () => ({
        where: async () => {
          selectCalled = true;
          return [];
        },
      }),
    }),
    transaction: async () => {
      transactionCalled = true;
      throw new Error("irrelevant inputs must not open a transaction");
    },
  };
  const block = {
    header: {
      number: 42n,
      hash: `0x${"42".repeat(32)}`,
      timestamp: 1_800_000_000_000n,
    },
    transactions: [
      {
        hash: () => `0x${"33".repeat(32)}`,
        inputs: [{ previousOutput: { txHash: `0x${"11".repeat(32)}`, index: 0n } }],
        outputs: [],
        outputsData: [],
        witnesses: [],
      },
    ],
  } as unknown as ClientBlock;
  const result = await new JobTransitionIndexer(database as never, {} as never).indexBlock(
    block,
    loaded.deployment,
  );
  assert.equal(selectCalled, true);
  assert.equal(transactionCalled, false);
  assert.deepEqual(result, {
    indexedTransitions: 0,
    terminalTransitions: 0,
    successorTransitions: 0,
    consumedByOther: 0,
  });
});
