import assert from "node:assert/strict";
import test from "node:test";

import { parseAnalyticsConsent } from "./analytics-consent-model.ts";

test("analytics consent fails closed for absent or altered values", () => {
  assert.equal(parseAnalyticsConsent(null), "unknown");
  assert.equal(parseAnalyticsConsent("yes"), "unknown");
  assert.equal(parseAnalyticsConsent("granted"), "granted");
  assert.equal(parseAnalyticsConsent("denied"), "denied");
});
