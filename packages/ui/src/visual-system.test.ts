import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CANONICAL_TRANSACTION_STATES } from "@ckb-automata/core";

import { TRANSACTION_STATE_LABELS } from "./labels.ts";
import {
  VISUAL_STORY_LARGE_AMOUNT,
  VISUAL_STORY_LONG_JOB_ID,
  VISUAL_STORY_VIEWPORTS,
} from "./visual-system.fixture-data.ts";

test("every status has explicit copy and a non-color icon mapping", async () => {
  assert.deepEqual(Object.keys(TRANSACTION_STATE_LABELS), [...CANONICAL_TRANSACTION_STATES]);
  const source = await readFile(new URL("./status.tsx", import.meta.url), "utf8");
  for (const state of CANONICAL_TRANSACTION_STATES) {
    assert.match(source, new RegExp(`\\b${state}: \\{ icon:`));
  }
  assert.match(source, /<Icon aria-hidden="true"/);
  assert.match(source, /<span>\{presentation\.label\}<\/span>/);
});

test("visual fixture covers fixed mobile and desktop viewports with adversarial values", () => {
  assert.deepEqual(VISUAL_STORY_VIEWPORTS, [
    { height: 900, name: "mobile", width: 320 },
    { height: 960, name: "desktop", width: 1440 },
  ]);
  assert.equal(VISUAL_STORY_LONG_JOB_ID.length, 66);
  assert.match(VISUAL_STORY_LARGE_AMOUNT, /9,223,372,036,854\.775808 CKB/);
});

test("tokens preserve focus, overflow, numeric, and reduced-motion behavior", async () => {
  const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /overflow-wrap: anywhere/);
  assert.match(styles, /font-variant-numeric: tabular-nums/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /@media \(max-width: 40rem\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
