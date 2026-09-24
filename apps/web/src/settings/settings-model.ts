import type { ApiNotificationPreferences, ApiRequestBody } from "@ckb-automata/api-client";

export const SETTINGS_SESSION_KEY = "ckb-automata:settings-session:v1";

export const NOTIFICATION_EVENTS = [
  { id: "ready", label: "Ready to execute" },
  { id: "submitted", label: "Transaction submitted" },
  { id: "confirmed", label: "Transaction confirmed" },
  { id: "failed", label: "Execution failed" },
  { id: "budget_low", label: "Budget running low" },
  { id: "cancelled", label: "Automation cancelled" },
  { id: "recovery_required", label: "Recovery required" },
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]["id"];

export interface StoredSettingsSession {
  readonly expiresAt: string;
  readonly ownerLockHash: string;
  readonly token: string;
}

export interface PreferencesDraft {
  readonly browser: {
    readonly enabled: boolean;
    readonly eventTypes: readonly NotificationEvent[];
  };
  readonly email: {
    readonly address: string;
    readonly enabled: boolean;
    readonly eventTypes: readonly NotificationEvent[];
  };
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function parseStoredSettingsSession(
  raw: string | null,
  ownerLockHash: string,
  now = Date.now(),
): StoredSettingsSession | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Readonly<Record<string, unknown>>;
    const expiresAt = value["expiresAt"];
    if (
      !isHash(value["ownerLockHash"]) ||
      value["ownerLockHash"] !== ownerLockHash ||
      !isToken(value["token"]) ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= now
    ) {
      return undefined;
    }
    return Object.freeze({
      expiresAt,
      ownerLockHash: value["ownerLockHash"],
      token: value["token"],
    });
  } catch {
    return undefined;
  }
}

export function preferencesDraft(preferences: ApiNotificationPreferences): PreferencesDraft {
  return Object.freeze({
    browser: Object.freeze({
      enabled: preferences.channels.browser.enabled,
      eventTypes: Object.freeze([...preferences.channels.browser.eventTypes]),
    }),
    email: Object.freeze({
      address: "",
      enabled: preferences.channels.email.enabled,
      eventTypes: Object.freeze([...preferences.channels.email.eventTypes]),
    }),
  });
}

export function toggleNotificationEvent(
  selected: readonly NotificationEvent[],
  event: NotificationEvent,
  checked: boolean,
): readonly NotificationEvent[] {
  const next = checked
    ? [...new Set([...selected, event])]
    : selected.filter((candidate) => candidate !== event);
  return Object.freeze(NOTIFICATION_EVENTS.map(({ id }) => id).filter((id) => next.includes(id)));
}

export function preferenceUpdate(
  draft: PreferencesDraft,
  options: Readonly<{ clearEmail?: boolean }> = {},
): ApiRequestBody<"NotificationPreferencesController_update"> {
  return {
    browser: {
      enabled: draft.browser.enabled,
      eventTypes: draft.browser.eventTypes,
    },
    email: {
      ...(options.clearEmail
        ? { address: null }
        : draft.email.address.trim()
          ? { address: draft.email.address.trim() }
          : {}),
      enabled: draft.email.enabled,
      eventTypes: draft.email.eventTypes,
    },
  };
}

export function resetPreferencesDraft(): PreferencesDraft {
  return Object.freeze({
    browser: Object.freeze({ enabled: false, eventTypes: Object.freeze([]) }),
    email: Object.freeze({ address: "", enabled: false, eventTypes: Object.freeze([]) }),
  });
}
