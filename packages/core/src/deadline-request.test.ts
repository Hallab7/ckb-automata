import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDeadlineCreationRequest } from "./deadline-request.ts";

interface Fixture {
  readonly valid: Record<string, unknown> & {
    readonly pledges: readonly Record<string, unknown>[];
  };
  readonly invalid: readonly {
    readonly name: string;
    readonly patch?: Readonly<Record<string, unknown>>;
    readonly pledgePatch?: Readonly<Record<string, unknown>>;
    readonly outPointPatch?: Readonly<Record<string, unknown>>;
  }[];
}

async function fixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/deadline_request_validation_v1.json", import.meta.url),
      "utf8",
    ),
  ) as Fixture;
}

function invalidRequest(valid: Fixture["valid"], invalid: Fixture["invalid"][number]) {
  const pledge = valid.pledges[0] ?? {};
  const outPoint = (pledge["outPoint"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...valid,
    ...invalid.patch,
    pledges: [
      {
        ...pledge,
        ...invalid.pledgePatch,
        outPoint: { ...outPoint, ...invalid.outPointPatch },
      },
    ],
  };
}

test("deadline request validation is canonical and fixture-driven", async () => {
  const data = await fixture();
  const parsed = parseDeadlineCreationRequest(data.valid);
  assert.equal(parsed.pledges[0]?.amount, "8000000000");
  assert.equal(parsed.pledges[0]?.outPoint.index, 0n);
  for (const invalid of data.invalid) {
    assert.throws(
      () => parseDeadlineCreationRequest(invalidRequest(data.valid, invalid)),
      invalid.name,
    );
  }
});
