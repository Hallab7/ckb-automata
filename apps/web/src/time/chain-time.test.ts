import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarDateParts,
  estimateBlockDate,
  formatBlockDate,
  formatBlockDuration,
  formatDateTime,
} from "./chain-time.ts";

test("block schedules become deterministic readable UTC dates", () => {
  const estimate = estimateBlockDate("160", "100", "2026-09-24T10:00:00.000Z");
  assert.equal(estimate?.toISOString(), "2026-09-24T10:10:00.000Z");
  assert.equal(
    formatBlockDate("160", "100", "2026-09-24T10:00:00.000Z"),
    "Sep 24, 2026, 10:10 AM UTC",
  );
  assert.equal(formatDateTime("2026-09-24T10:00:00.000Z"), "Sep 24, 2026, 10:00 AM UTC");
});

test("calendar and duration helpers stay compact", () => {
  assert.deepEqual(calendarDateParts("2026-09-24T10:00:00.000Z"), {
    day: "24",
    month: "SEP",
  });
  assert.equal(formatBlockDuration(20n), "4 min");
  assert.equal(formatBlockDuration(720n), "2 hr");
  assert.equal(formatBlockDuration(17_280n), "2 days");
});

test("invalid schedule inputs fail closed", () => {
  assert.equal(estimateBlockDate("bad", "100", "2026-09-24T10:00:00.000Z"), undefined);
  assert.equal(formatBlockDate("100", "bad", "invalid"), "Schedule time unavailable");
  assert.equal(formatDateTime("invalid"), "Time unavailable");
});
