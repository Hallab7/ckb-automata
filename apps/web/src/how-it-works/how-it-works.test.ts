import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../../app/(product)/how-it-works/page.tsx", import.meta.url),
  "utf8",
);

test("how it works explains the complete automation flow in plain language", () => {
  for (const copy of [
    "Set the payment details",
    "Review and approve",
    "Your funds are secured",
    "An executor starts the payment",
    "CKB completes the payment",
    "your wallet does not need to stay connected",
  ]) {
    assert.match(pageSource, new RegExp(copy, "i"));
  }
});

test("how it works states the executor and fund-safety boundaries", () => {
  assert.match(pageSource, /receives the automation charge/i);
  assert.match(pageSource, /can only submit a payment that follows/i);
  assert.match(pageSource, /funds stay secured/i);
});
