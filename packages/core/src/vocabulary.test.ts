import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CANONICAL_TERMS, CANONICAL_TRANSACTION_STATES, GLOSSARY } from "./vocabulary.ts";

test("the glossary defines every required concept", () => {
  assert.deepEqual(Object.keys(GLOSSARY), [...CANONICAL_TERMS]);
  for (const definition of Object.values(GLOSSARY)) {
    assert.ok(definition.length >= 40);
  }
});

test("transaction confidence states are distinct and unambiguous", () => {
  assert.match(GLOSSARY.submitted, /not included in a block/);
  assert.match(GLOSSARY.committed, /below the configured confirmation depth/);
  assert.match(GLOSSARY.confirmed, /at or beyond the configured confirmation depth/);
  assert.ok(!CANONICAL_TRANSACTION_STATES.includes("scheduled" as never));
  assert.ok(!CANONICAL_TRANSACTION_STATES.includes("executed" as never));
});

test("contract documentation maps every canonical term", async () => {
  const documentation = await readFile(
    new URL("../../../docs/protocol/vocabulary.md", import.meta.url),
    "utf8",
  );

  for (const term of CANONICAL_TERMS) {
    assert.match(
      documentation,
      new RegExp("\\|\\s+`" + term + "`\\s+\\|"),
      `missing contract mapping for ${term}`,
    );
  }
});
