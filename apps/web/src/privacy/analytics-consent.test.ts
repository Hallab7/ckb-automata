import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const consentSource = await readFile(new URL("./analytics-consent.tsx", import.meta.url), "utf8");

test("analytics is enabled without displaying a consent prompt", () => {
  assert.match(consentSource, /return <Analytics beforeSend=\{filterAnalyticsEvent\} \/>/);
  assert.doesNotMatch(consentSource, /analytics-consent__actions|>Decline<|>Allow</);
  assert.match(consentSource, /url\.search = ""/);
  assert.match(consentSource, /url\.hash = ""/);
});
