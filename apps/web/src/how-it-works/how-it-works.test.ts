import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../../app/(product)/how-it-works/page.tsx", import.meta.url),
  "utf8",
);
const tabsSource = await readFile(new URL("./how-it-works-tabs.tsx", import.meta.url), "utf8");
const guideSource = `${pageSource}\n${tabsSource}`;

test("how it works explains the complete automation flow in plain language", () => {
  for (const copy of [
    "Scheduled payment",
    "Recurring distribution",
    "DAO harvest",
    "Enter the payment details",
    "Choose the repeat schedule",
    "Wait for the DAO cycle",
    "Receive the compensation",
    "Review and approve",
    "Payment status",
  ]) {
    assert.match(guideSource, new RegExp(copy, "i"));
  }
});

test("how it works remains a standalone product guide", () => {
  assert.doesNotMatch(guideSource, /executor/i);
  assert.match(pageSource, /Confirming means the automation is being created/i);
  assert.match(pageSource, /stop, cancel, exit, or recover/i);
  assert.match(tabsSource, /role="tablist"/i);
  assert.match(tabsSource, /role="tabpanel"/i);
});
