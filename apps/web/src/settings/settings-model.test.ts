import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStoredSettingsSession,
  preferenceUpdate,
  resetPreferencesDraft,
  toggleNotificationEvent,
} from "./settings-model.ts";

const OWNER_A = `0x${"11".repeat(32)}`;
const OWNER_B = `0x${"22".repeat(32)}`;
const TOKEN = "A".repeat(43);

test("stored settings sessions are accepted only for the current unexpired owner", () => {
  const raw = JSON.stringify({
    expiresAt: "2026-09-24T14:00:00.000Z",
    ownerLockHash: OWNER_A,
    token: TOKEN,
  });
  const now = Date.parse("2026-09-24T13:00:00.000Z");

  assert.equal(parseStoredSettingsSession(raw, OWNER_A, now)?.token, TOKEN);
  assert.equal(parseStoredSettingsSession(raw, OWNER_B, now), undefined);
  assert.equal(
    parseStoredSettingsSession(raw, OWNER_A, Date.parse("2026-09-24T14:00:00.000Z")),
    undefined,
  );
  assert.equal(parseStoredSettingsSession("not-json", OWNER_A, now), undefined);
});

test("notification event selection stays canonical and duplicate-free", () => {
  assert.deepEqual(toggleNotificationEvent(["failed"], "ready", true), ["ready", "failed"]);
  assert.deepEqual(toggleNotificationEvent(["ready", "failed"], "ready", true), [
    "ready",
    "failed",
  ]);
  assert.deepEqual(toggleNotificationEvent(["ready", "failed"], "ready", false), ["failed"]);
});

test("reset explicitly opts out and clears the private email destination", () => {
  const reset = resetPreferencesDraft();
  assert.deepEqual(preferenceUpdate(reset, { clearEmail: true }), {
    browser: { enabled: false, eventTypes: [] },
    email: { address: null, enabled: false, eventTypes: [] },
  });
});

test("an unchanged masked email is omitted from preference updates", () => {
  const update = preferenceUpdate({
    browser: { enabled: true, eventTypes: ["ready"] },
    email: { address: "", enabled: true, eventTypes: ["failed"] },
  });
  assert.equal(update.email.address, undefined);
});
