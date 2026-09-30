import assert from "node:assert/strict";
import test from "node:test";

import { packClientEpoch } from "./epoch.ts";

test("packs the structured epoch returned by the live CCC client", () => {
  assert.equal(
    packClientEpoch({ integer: 13_920n, numerator: 1_088n, denominator: 1_800n }),
    0x708_0440_003660n,
  );
});

test("accepts canonical packed epoch values used by stored snapshots", () => {
  assert.equal(packClientEpoch("0x708040f003660"), 0x708_040f_003660n);
  assert.equal(packClientEpoch(0x708_040f_003660n), 0x708_040f_003660n);
});

test("rejects incomplete structured epochs", () => {
  assert.throws(
    () => packClientEpoch({ integer: 13_920n, numerator: 1_088n }),
    /fraction is incomplete/,
  );
});
