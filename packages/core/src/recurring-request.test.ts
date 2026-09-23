import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseRecurringCreationRequest } from "./recurring-request.ts";

interface Fixture {
  readonly valid: Readonly<Record<string, unknown>>;
  readonly invalid: readonly {
    readonly name: string;
    readonly patch: Readonly<Record<string, unknown>>;
  }[];
}

test("recurring request validation is canonical and fixture-driven", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/recurring_request_validation_v1.json", import.meta.url),
      "utf8",
    ),
  ) as Fixture;
  const parsed = parseRecurringCreationRequest(fixture.valid);
  assert.equal(parsed.amount, "10000000000");
  assert.equal(parsed.totalRuns, "3");
  for (const invalid of fixture.invalid) {
    assert.throws(
      () => parseRecurringCreationRequest({ ...fixture.valid, ...invalid.patch }),
      invalid.name,
    );
  }
});
