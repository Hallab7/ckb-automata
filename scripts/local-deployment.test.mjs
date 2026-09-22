import assert from "node:assert/strict";
import test from "node:test";

import {
  ckbHash,
  LOCAL_LOCK_ARG,
  occupiedShannons,
  parseDepGroup,
  signSingleInput,
  toRpcTransaction,
} from "./lib/ckb-local.mjs";

const lock = { codeHash: `0x${"12".repeat(32)}`, hashType: "type", args: LOCAL_LOCK_ARG };

test("occupied capacity includes lock, type, and data bytes", () => {
  const type = {
    codeHash: `0x${"34".repeat(32)}`,
    hashType: "data1",
    args: `0x${"56".repeat(32)}`,
  };
  assert.equal(occupiedShannons({ capacity: "0x0", lock, type }, "0xaabb"), 12800000000n);
});

test("CKB hashing uses chain personalization", () => {
  assert.equal(
    ckbHash(new Uint8Array()),
    "0x44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e",
  );
});

test("dependency groups decode canonical outpoints", () => {
  const data = `0x02000000${"11".repeat(32)}03000000${"22".repeat(32)}04000000`;
  assert.deepEqual(parseDepGroup(data), [
    { txHash: `0x${"11".repeat(32)}`, index: "0x3" },
    { txHash: `0x${"22".repeat(32)}`, index: "0x4" },
  ]);
  assert.deepEqual(parseDepGroup("0x01000000"), []);
});

test("signed transactions retain type witness data and map to RPC names", () => {
  const transaction = {
    version: "0x0",
    cellDeps: [{ outPoint: { txHash: `0x${"01".repeat(32)}`, index: "0x0" }, depType: "depGroup" }],
    headerDeps: [],
    inputs: [{ since: "0x0", previousOutput: { txHash: `0x${"02".repeat(32)}`, index: "0x1" } }],
    outputs: [{ capacity: "0x174876e800", lock, type: null }],
    outputsData: ["0x"],
    witnesses: [],
  };
  const signed = signSingleInput(transaction, { lock: "", inputType: "", outputType: "0xaabb" });
  assert.match(signed.witnesses[0], /^0x[0-9a-f]+$/);
  const rpc = toRpcTransaction(signed);
  assert.equal(rpc.cell_deps[0].dep_type, "dep_group");
  assert.equal(rpc.outputs[0].lock.code_hash, lock.codeHash);
  assert.equal(rpc.witnesses.length, 1);
});
