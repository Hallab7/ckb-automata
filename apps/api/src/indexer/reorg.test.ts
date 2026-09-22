import assert from "node:assert/strict";
import test from "node:test";

import { CheckpointError } from "./checkpoints.ts";

test("reorg rollback failures preserve the stable checkpoint error contract", () => {
  const error = new CheckpointError(
    "REORG_BEYOND_WINDOW",
    "reorg parent is not in the retained canonical window",
  );
  assert.equal(error.code, "REORG_BEYOND_WINDOW");
  assert.doesNotMatch(error.message, /postgres|rpc|url/i);
});
