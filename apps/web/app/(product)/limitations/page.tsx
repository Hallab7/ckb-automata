import { Activity, Database, FlaskConical, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { AnalyticsPreferences } from "../../../src/privacy/analytics-consent.tsx";
import { PageHeader } from "../../../src/shell/page-header.tsx";

export const metadata: Metadata = {
  title: "Privacy and limitations",
};

const limitations = [
  {
    description:
      "This deployment is bound to CKB Pudge testnet. Testnet CKB has no monetary value, and mainnet signing is blocked.",
    icon: FlaskConical,
    title: "Testnet only",
  },
  {
    description:
      "Contracts and transaction builders are experimental. Review every wallet request; no availability, profit, or execution guarantee is made.",
    icon: ShieldCheck,
    title: "Showcase status",
  },
  {
    description:
      "The API relies on an external PostgreSQL service, a non-persistent showcase Redis tier, and a community public CKB endpoint.",
    icon: Database,
    title: "Infrastructure",
  },
  {
    description:
      "Independent executor services are not active yet. A funded automation will not run unattended until executor deployment and acceptance are complete.",
    icon: Activity,
    title: "Automated execution",
  },
] as const;

export default function LimitationsPage() {
  return (
    <div className="app-page limitations-page">
      <PageHeader
        description="Public deployment boundaries, service assumptions, and browser privacy choices."
        title="Privacy and limitations"
      />
      <div className="limitations-list">
        {limitations.map(({ description, icon: Icon, title }) => (
          <section key={title}>
            <Icon aria-hidden="true" size={20} />
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </section>
        ))}
      </div>
      <section aria-labelledby="analytics-preferences-title" className="limitations-analytics">
        <div>
          <p className="limitations-eyebrow">Browser privacy</p>
          <h2 id="analytics-preferences-title">Analytics preference</h2>
        </div>
        <AnalyticsPreferences />
      </section>
    </div>
  );
}
