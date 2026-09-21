import assert from "node:assert/strict";
import test from "node:test";

import { REDACTED_VALUE, redactLogRecord } from "./redaction.ts";

test("sensitive keys are redacted recursively", () => {
  const input = {
    authorization: "Bearer configured-secret-value",
    databaseUrl: "postgresql://user:password@database/app",
    nested: {
      executor_fee_private_key: "operator-key-value",
      safe: "visible",
    },
  };

  const output = redactLogRecord(input);
  assert.deepEqual(output, {
    authorization: REDACTED_VALUE,
    databaseUrl: REDACTED_VALUE,
    nested: {
      executor_fee_private_key: REDACTED_VALUE,
      safe: "visible",
    },
  });
  assert.equal(input.nested.safe, "visible");
});

test("configured values are removed from free-form messages", () => {
  const secret = "configured-secret-value";
  const output = redactLogRecord(
    {
      message: `connection rejected for ${secret}`,
      values: ["public", secret],
    },
    [secret],
  );

  assert.deepEqual(output, {
    message: `connection rejected for ${REDACTED_VALUE}`,
    values: ["public", REDACTED_VALUE],
  });
});

test("circular values do not crash log redaction", () => {
  const input: { self?: unknown } = {};
  input.self = input;
  assert.deepEqual(redactLogRecord(input), { self: "[CIRCULAR]" });
});
