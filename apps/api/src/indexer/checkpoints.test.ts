import assert from "node:assert/strict";
import test from "node:test";

import { parseBlockNumber, parseHash32 } from "@ckb-automata/core";

import {
  CheckpointError,
  planCheckpointTransition,
  type CanonicalPosition,
} from "./checkpoints.ts";

function hash(byte: string) {
  return parseHash32(`0x${byte.repeat(32)}`);
}

function position(blockNumber: bigint, byte: string): CanonicalPosition {
  return { blockNumber: parseBlockNumber(blockNumber), blockHash: hash(byte) };
}

function incoming(blockNumber: bigint, byte: string, parentByte: string) {
  return {
    networkId: "local",
    ...position(blockNumber, byte),
    parentHash: hash(parentByte),
    blockTimestamp: blockNumber * 1_000n,
  };
}

test("checkpoint transition initializes, advances, and replays idempotently", () => {
  assert.deepEqual(planCheckpointTransition({ incoming: incoming(10n, "10", "09") }), {
    status: "initialized",
    rolledBackBlocks: 0,
  });
  assert.deepEqual(
    planCheckpointTransition({
      current: position(10n, "10"),
      parentInWindow: position(10n, "10"),
      incoming: incoming(11n, "11", "10"),
    }),
    { status: "advanced", rolledBackBlocks: 0 },
  );
  assert.deepEqual(
    planCheckpointTransition({
      current: position(12n, "12"),
      existingAtHeight: position(11n, "11"),
      incoming: incoming(11n, "11", "10"),
    }),
    { status: "unchanged", rolledBackBlocks: 0 },
  );
});

test("checkpoint transition reports controlled single and multi-block rollback", () => {
  assert.deepEqual(
    planCheckpointTransition({
      current: position(12n, "12"),
      existingAtHeight: position(12n, "aa"),
      parentInWindow: position(11n, "11"),
      incoming: incoming(12n, "bb", "11"),
    }),
    { status: "reorganized", rolledBackBlocks: 1, rollbackAfter: 11n },
  );
  assert.deepEqual(
    planCheckpointTransition({
      current: position(14n, "14"),
      existingAtHeight: position(13n, "13"),
      parentInWindow: position(12n, "12"),
      incoming: incoming(13n, "cc", "12"),
    }),
    { status: "reorganized", rolledBackBlocks: 2, rollbackAfter: 12n },
  );
});

test("gaps and parents outside the retained window fail closed", () => {
  assert.throws(
    () =>
      planCheckpointTransition({
        current: position(10n, "10"),
        incoming: incoming(12n, "12", "11"),
      }),
    (error: unknown) => error instanceof CheckpointError && error.code === "NON_CONTIGUOUS_BLOCK",
  );
  assert.throws(
    () =>
      planCheckpointTransition({
        current: position(14n, "14"),
        incoming: incoming(11n, "bb", "10"),
      }),
    (error: unknown) => error instanceof CheckpointError && error.code === "REORG_BEYOND_WINDOW",
  );
});
