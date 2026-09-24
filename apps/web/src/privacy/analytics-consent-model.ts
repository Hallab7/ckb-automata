export const ANALYTICS_CONSENT_KEY = "ckb-automata.analytics-consent.v1";

export type AnalyticsConsentValue = "granted" | "denied" | "unknown";

export function parseAnalyticsConsent(value: string | null): AnalyticsConsentValue {
  return value === "granted" || value === "denied" ? value : "unknown";
}
