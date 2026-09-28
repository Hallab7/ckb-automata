import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../../app/(product)/how-it-works/page.tsx", import.meta.url),
  "utf8",
);

test("how it works explains the complete automation flow in plain language", () => {
  for (const copy of [
    "Choose an automation",
    "Enter the payment details",
    "Set the schedule",
    "Review and approve",
    "Track the automation",
    "Schedule payment",
    "Recurring distribution",
    "Payment status",
    "Manage an automation",
  ]) {
    assert.match(pageSource, new RegExp(copy, "i"));
  }
});

test("how it works remains a standalone product guide", () => {
  assert.doesNotMatch(pageSource, /executor/i);
  assert.match(pageSource, /Submitting and Confirming/i);
  assert.match(pageSource, /cancel it, add funds, or recover/i);
});
