import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "@ckb-automata/api-client";

import { detailRequestError, requestErrorMessage } from "./request-errors.ts";

test("recoverable request errors use concise retry guidance", () => {
  for (const message of [
    requestErrorMessage("dashboard", new ApiClientError(409, {})),
    requestErrorMessage("activity", new ApiClientError(503, {})),
    requestErrorMessage("dashboard", new ApiClientError(400, {})),
    requestErrorMessage("activity", new TypeError("offline")),
    requestErrorMessage("dashboard", new Error("unknown")),
  ]) {
    assert.equal(message, "Something went wrong. Please try again.");
  }
});

test("detail errors distinguish missing records from retryable failures", () => {
  assert.deepEqual(detailRequestError(new ApiClientError(404, {})), {
    message: "The automation was not found at the current checkpoint.",
    state: "not_found",
  });
  assert.equal(detailRequestError(new ApiClientError(409, {})).state, "error");
  assert.equal(
    detailRequestError(new ApiClientError(500, {})).message,
    "Something went wrong. Please try again.",
  );
  assert.equal(
    detailRequestError(new TypeError("offline")).message,
    "Something went wrong. Please try again.",
  );
  assert.equal(
    detailRequestError(new Error("unknown")).message,
    "Something went wrong. Please try again.",
  );
});
