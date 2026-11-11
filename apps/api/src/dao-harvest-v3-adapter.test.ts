import assert from "node:assert/strict";
import test from "node:test";

import { parseHash32, scriptIdentityHash } from "@ckb-automata/core";

import { daoHarvestV3PolicyScriptHash } from "./dao-harvest-v3-adapter.ts";

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
