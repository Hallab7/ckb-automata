import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "@ckb-automata/api-client";

import { detailRequestError, requestErrorMessage } from "./request-errors.ts";

test("recoverable request errors preserve conflict, outage, transport, and fallback guidance", () => {
  assert.match(requestErrorMessage("dashboard", new ApiClientError(409, {})), /Refresh/);
  assert.match(requestErrorMessage("activity", new ApiClientError(503, {})), /temporarily/);
  assert.match(requestErrorMessage("dashboard", new ApiClientError(400, {})), /rejected/);
  assert.match(requestErrorMessage("activity", new TypeError("offline")), /retry/);
  assert.match(requestErrorMessage("dashboard", new Error("unknown")), /could not be loaded/);
});

test("detail errors distinguish missing records from retryable failures", () => {
  assert.deepEqual(detailRequestError(new ApiClientError(404, {})), {
    message: "The automation was not found at the current checkpoint.",
    state: "not_found",
  });
  assert.equal(detailRequestError(new ApiClientError(409, {})).state, "error");
  assert.match(detailRequestError(new ApiClientError(500, {})).message, /temporarily/);
  assert.match(detailRequestError(new TypeError("offline")).message, /retry/);
  assert.match(detailRequestError(new Error("unknown")).message, /could not be loaded/);
});
