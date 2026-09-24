"use client";

import { BarChart3, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

import { Button } from "@ckb-automata/ui";

import {
  ANALYTICS_CONSENT_KEY,
  parseAnalyticsConsent,
  type AnalyticsConsentValue,
} from "./analytics-consent-model.ts";

const CONSENT_EVENT = "ckb-automata:analytics-consent";

function readConsent(): AnalyticsConsentValue {
  return parseAnalyticsConsent(window.localStorage.getItem(ANALYTICS_CONSENT_KEY));
}

function useAnalyticsConsent() {
  const [consent, setConsent] = useState<AnalyticsConsentValue>("unknown");
  useEffect(() => {
    const update = () => setConsent(readConsent());
    update();
    window.addEventListener(CONSENT_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CONSENT_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const choose = useCallback((value: Exclude<AnalyticsConsentValue, "unknown">) => {
    window.localStorage.setItem(ANALYTICS_CONSENT_KEY, value);
    window.dispatchEvent(new Event(CONSENT_EVENT));
  }, []);
  return { choose, consent } as const;
}

function filterAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  if (readConsent() !== "granted") return null;
  const url = new URL(event.url);
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}

export function AnalyticsConsent() {
  const { choose, consent } = useAnalyticsConsent();
  return (
    <>
      {consent === "granted" ? <Analytics beforeSend={filterAnalyticsEvent} /> : null}
      {consent === "unknown" ? (
        <section aria-label="Analytics preference" className="analytics-consent">
          <BarChart3 aria-hidden="true" size={20} />
          <div>
            <strong>Anonymous analytics</strong>
            <p>
              Allow privacy-focused page-view analytics. No analytics script loads until you agree.{" "}
              <Link href="/limitations">Review privacy and limitations</Link>.
            </p>
          </div>
          <div className="analytics-consent__actions">
            <Button onClick={() => choose("denied")} tone="ghost">
              Decline
            </Button>
            <Button onClick={() => choose("granted")}>Allow</Button>
          </div>
        </section>
      ) : null}
    </>
  );
}

export function AnalyticsPreferences() {
  const { choose, consent } = useAnalyticsConsent();
  return (
    <div className="analytics-preferences">
      <div>
        <span className="analytics-preferences__icon">
          <ShieldCheck aria-hidden="true" size={18} />
        </span>
        <div>
          <strong>Anonymous page-view analytics</strong>
          <p>
            {consent === "granted"
              ? "Allowed on this browser. Query strings and URL fragments are removed."
              : consent === "denied"
                ? "Declined on this browser. The analytics script is not loaded."
                : "No choice is stored. The analytics script is not loaded."}
          </p>
        </div>
      </div>
      <div className="analytics-preferences__actions">
        <Button onClick={() => choose("denied")} tone="secondary">
          Decline
        </Button>
        <Button onClick={() => choose("granted")}>Allow</Button>
      </div>
    </div>
  );
}
