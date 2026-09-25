import assert from "node:assert/strict";
import test from "node:test";

import { assertCanonicalReviewWindow } from "./review-window.ts";

const HASH = `0x${"11".repeat(32)}`;
const reviewed = Object.freeze({
  blockHash: HASH,
  blockNumber: "100",
  expiresAfterBlock: "130",
});

test("a canonical review remains valid while the tip advances inside its window", () => {
  assert.doesNotThrow(() => assertCanonicalReviewWindow(reviewed, 112n, HASH));
  assert.doesNotThrow(() => assertCanonicalReviewWindow(reviewed, 130n, HASH));
});

test("an expired review is rejected before signing", () => {
  assert.throws(() => assertCanonicalReviewWindow(reviewed, 131n, HASH), /expired/);
});

test("a noncanonical reviewed block is rejected before signing", () => {
  assert.throws(
    () => assertCanonicalReviewWindow(reviewed, 112n, `0x${"22".repeat(32)}`),
    /no longer canonical/,
  );
});

test("malformed or reversed windows fail closed", () => {
  assert.throws(
    () => assertCanonicalReviewWindow({ ...reviewed, blockNumber: "0100" }, 112n, HASH),
    /not a canonical block number/,
  );
  assert.throws(
    () => assertCanonicalReviewWindow({ ...reviewed, expiresAfterBlock: "99" }, 100n, HASH),
    /invalid expiry/,
  );
});
