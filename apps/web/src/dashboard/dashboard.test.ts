import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard consumes generated public and owner job reads", async () => {
  const source = await readFile(new URL("./automation-dashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /listJobs\(query\)/);
  assert.match(source, /listAccountJobs\(session\.ownerLockHash!/);
  assert.match(source, /cursor: nextCursor/);
  assert.match(source, /stateFilter/);
  assert.match(source, /templateFilter/);
});

test("dashboard fixture covers lifecycle, operational, and request states", async () => {
  const source = await readFile(new URL("./dashboard.fixture.tsx", import.meta.url), "utf8");
  for (const state of [
    'fixtureJob("1", "live"',
    'fixtureJob("5", "spent"',
    'fixtureJob("6", "orphaned"',
    '"ready", "loading", "empty", "owner_required", "error"',
  ]) {
    assert.ok(source.includes(state), `${state} is missing`);
  }
  assert.equal((source.match(/fixtureJob\(/g) ?? []).length, 7);
});
