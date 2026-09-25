import assert from "node:assert/strict";
import test from "node:test";

import { parseBlockNumber, parseHash32 } from "@ckb-automata/core";

import type { ExecutorHeaderSnapshot } from "./adapter.ts";
import { assertSnapshotTipContinuity } from "./build-snapshot.ts";

function header(number: bigint, byte: string): ExecutorHeaderSnapshot {
  return {
    hash: parseHash32(`0x${byte.repeat(64)}`),
    number: parseBlockNumber(number),
    epoch: "0x0",
    timestamp: "0x0",
  };
}

test("snapshot continuity permits normal tip advancement", () => {
  assert.doesNotThrow(() => assertSnapshotTipContinuity(header(100n, "a"), header(103n, "b")));
  assert.doesNotThrow(() => assertSnapshotTipContinuity(header(100n, "a"), header(100n, "a")));
});

test("snapshot continuity rejects regressions and same-height replacements", () => {
  for (const after of [header(99n, "9"), header(100n, "b")]) {
    assert.throws(
      () => assertSnapshotTipContinuity(header(100n, "a"), after),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "EXECUTOR_CHAIN_SNAPSHOT_MOVED");
        return true;
      },
    );
  }
});
