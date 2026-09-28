import {
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  LockKeyhole,
  Radar,
  RotateCcw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import type { Metadata } from "next";

import { PageHeader } from "../../../src/shell/page-header.tsx";

export const metadata: Metadata = {
  description: "A simple guide to creating and running payment automations with CKAutomata.",
  title: "How it works",
};

const steps = [
  {
    description:
      "Choose who should be paid, how much they should receive, and the date and time for the payment. For recurring payments, also choose how often it repeats.",
    icon: CalendarClock,
    title: "Set the payment details",
  },
  {
    description:
      "Check the recipient amount, charges, and total. Your wallet will show the exact transaction before you approve it.",
    icon: WalletCards,
    title: "Review and approve",
  },
  {
    description:
      "Once approved, the payment funds are secured on CKB. CKAutomata cannot send them somewhere else or change the amount you approved.",
    icon: LockKeyhole,
    title: "Your funds are secured",
  },
  {
    description:
      "After the scheduled time arrives, an executor prepares the payment. An executor can be an automated service or anyone running compatible software.",
    icon: Radar,
    title: "An executor starts the payment",
  },
  {
    description:
      "The CKB network checks every rule before accepting the payment. When confirmed, the recipient receives the funds and the automation is marked completed.",
    icon: CheckCircle2,
    title: "CKB completes the payment",
  },
] as const;

export default function HowItWorksPage() {
  return (
    <div className="app-page how-it-works-page">
      <PageHeader
        description="Schedule a payment once, and CKAutomata handles the rest without taking control of your wallet."
        title="How it works"
      />

      <ol aria-label="How CKAutomata works" className="how-it-works-flow">
        {steps.map(({ description, icon: Icon, title }, index) => (
          <li key={title}>
            <div aria-hidden="true" className="how-it-works-flow__marker">
              <Icon size={20} />
            </div>
            <div className="how-it-works-flow__copy">
              <span>Step {index + 1}</span>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </li>
        ))}
      </ol>

      <section aria-labelledby="important-details-title" className="how-it-works-details">
        <div className="how-it-works-details__heading">
          <span>Good to know</span>
          <h2 id="important-details-title">Simple answers to important questions</h2>
        </div>
        <div className="how-it-works-details__list">
          <article>
            <CircleDollarSign aria-hidden="true" size={20} />
            <div>
              <h3>What does the executor earn?</h3>
              <p>
                The executor that completes the payment receives the automation charge. It pays the
                CKB network fee from that amount.
              </p>
            </div>
          </article>
          <article>
            <ShieldCheck aria-hidden="true" size={20} />
            <div>
              <h3>Can an executor take my funds?</h3>
              <p>
                No. The executor can only submit a payment that follows the recipient, amount, and
                schedule you approved. CKB rejects changes.
              </p>
            </div>
          </article>
          <article>
            <RotateCcw aria-hidden="true" size={20} />
            <div>
              <h3>What if an executor is late?</h3>
              <p>
                Your funds stay secured. The payment can be completed by an available executor after
                the scheduled time, and your wallet does not need to stay connected.
              </p>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
