"use client";

import { useState } from "react";

import type { ApiNotificationPreferences, ApiWebhookList } from "@ckb-automata/api-client";

import { preferencesDraft, type PreferencesDraft } from "./settings-model.ts";
import { SettingsView } from "./settings-view.tsx";

const OWNER = `0x${"11".repeat(32)}`;

const preferences: ApiNotificationPreferences = {
  channels: {
    browser: { enabled: true, eventTypes: ["ready", "failed", "recovery_required"] },
    email: {
      address: "a***@example.com",
      enabled: true,
      eventTypes: ["confirmed", "budget_low"],
    },
  },
  network: "ckb_testnet",
  ownerLockHash: OWNER,
};

const webhooks: ApiWebhookList["items"] = [
  {
    createdAt: "2026-09-24T10:00:00.000Z",
    enabled: true,
    endpoint: "https://hooks.example.com/automata",
    eventTypes: ["ready", "confirmed", "failed"],
    id: "11111111-1111-4111-8111-111111111111",
    secretVersion: 2,
    updatedAt: "2026-09-24T11:00:00.000Z",
  },
  {
    createdAt: "2026-09-23T10:00:00.000Z",
    enabled: false,
    endpoint: "https://archive.example.com/events",
    eventTypes: ["cancelled", "recovery_required"],
    id: "22222222-2222-4222-8222-222222222222",
    secretVersion: 1,
    updatedAt: "2026-09-23T10:00:00.000Z",
  },
];

export function SettingsFixture() {
  const [draft, setDraft] = useState<PreferencesDraft>(() => preferencesDraft(preferences));
  return (
    <div className="settings-fixture">
      <SettingsView
        address="ckt1qfixtureaddress000000000000000000000000000000000000"
        expiresAt="2026-09-24T22:00:00.000Z"
        network="ckb_testnet"
        onAuthenticate={() => undefined}
        onConnect={() => undefined}
        onDraftChange={setDraft}
        onLoadDeliveries={() => undefined}
        onRegisterWebhook={() => undefined}
        onReplayDelivery={() => undefined}
        onReset={() => undefined}
        onRetry={() => undefined}
        onRotateWebhook={() => undefined}
        onSavePreferences={() => undefined}
        onSignOut={() => undefined}
        onUpdateWebhook={() => undefined}
        ownerLockHash={OWNER}
        preferences={preferences}
        preferencesDraft={draft}
        status="ready"
        webhooks={webhooks}
      />
    </div>
  );
}
