"use client";

import { ShieldCheck } from "lucide-react";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

function filterAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = new URL(event.url);
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}

export function AnalyticsConsent() {
  return <Analytics beforeSend={filterAnalyticsEvent} />;
}

export function AnalyticsPreferences() {
  return (
    <div className="analytics-preferences">
      <div>
        <span className="analytics-preferences__icon">
          <ShieldCheck aria-hidden="true" size={18} />
        </span>
        <div>
          <strong>Anonymous page-view analytics</strong>
          <p>Always enabled. Query strings and URL fragments are removed before collection.</p>
        </div>
      </div>
    </div>
  );
}
