import { Activity, CircleStop, LockKeyhole, Wallet } from "lucide-react";
import type { Metadata } from "next";

import { HowItWorksTabs } from "../../../src/how-it-works/how-it-works-tabs.tsx";
import { PageHeader } from "../../../src/shell/page-header.tsx";

export const metadata: Metadata = {
  description: "A simple guide to CKAutomata payments, recurring distributions, and DAO harvests.",
  title: "How it works",
};

export default function HowItWorksPage() {
  return (
    <div className="app-page how-it-works-page">
      <PageHeader
        description="Choose an automation below to see what you approve and what happens next."
        title="How it works"
      />

      <HowItWorksTabs />

      <section aria-labelledby="important-details-title" className="how-it-works-details">
        <div className="how-it-works-details__heading">
          <span>Using CKAutomata</span>
          <h2 id="important-details-title">You remain in control</h2>
        </div>
        <div className="how-it-works-details__list">
          <article>
            <Wallet aria-hidden="true" size={20} />
            <div>
              <h3>Your wallet approves the setup</h3>
              <p>
                CKAutomata never receives your private key or seed phrase. Your wallet shows the
                transaction before you approve it.
              </p>
            </div>
          </article>
          <article>
            <LockKeyhole aria-hidden="true" size={20} />
            <div>
              <h3>The approved rules protect your funds</h3>
              <p>
                The automation can only follow the amount, addresses, schedule, and limits you
                approved. Changing them requires a new wallet approval.
              </p>
            </div>
          </article>
          <article>
            <Activity aria-hidden="true" size={20} />
            <div>
              <h3>Payment status</h3>
              <p>
                Confirming means the automation is being created. Waiting means it is ready for the
                correct time, Processing means an action is underway, and Completed means it has
                finished.
              </p>
            </div>
          </article>
          <article>
            <CircleStop aria-hidden="true" size={20} />
            <div>
              <h3>Owner actions require your wallet</h3>
              <p>
                When an owner action is available, only the wallet that created the automation can
                stop, cancel, exit, or recover it.
              </p>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
