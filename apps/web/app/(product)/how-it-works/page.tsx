import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ListChecks,
  LockKeyhole,
  Repeat2,
  RotateCcw,
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
      "Choose Schedule payment for one future payment, or Recurring distribution for a payment that repeats.",
    icon: ListChecks,
    title: "Choose an automation",
  },
  {
    description:
      "Add a title, recipient address, and payment amount. A title is optional, but it can make the automation easier to find later.",
    icon: WalletCards,
    title: "Enter the payment details",
  },
  {
    description:
      "Choose a future date and time. For a recurring distribution, also choose how often it repeats and the number of payments.",
    icon: CalendarClock,
    title: "Set the schedule",
  },
  {
    description:
      "Check the recipient amount, combined charges, and total deposit. Your wallet shows the exact transaction before you approve it.",
    icon: LockKeyhole,
    title: "Review and approve",
  },
  {
    description:
      "Open Automations to follow progress. The payment stays secured until its scheduled time and is sent according to the details you approved.",
    icon: CheckCircle2,
    title: "Track the automation",
  },
] as const;

export default function HowItWorksPage() {
  return (
    <div className="app-page how-it-works-page">
      <PageHeader
        description="A simple guide to creating, tracking, and managing automated CKB payments."
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
          <span>Using CKAutomata</span>
          <h2 id="important-details-title">Understand your automation</h2>
        </div>
        <div className="how-it-works-details__list">
          <article>
            <CalendarClock aria-hidden="true" size={20} />
            <div>
              <h3>Schedule payment</h3>
              <p>
                Runs once at the selected date and time. You choose whether the amount is sent to
                the recipient or returned to the refund address.
              </p>
            </div>
          </article>
          <article>
            <Repeat2 aria-hidden="true" size={20} />
            <div>
              <h3>Recurring distribution</h3>
              <p>
                Sends the same amount more than once. You choose the first payment time, repeat
                interval, and total number of payments.
              </p>
            </div>
          </article>
          <article>
            <Activity aria-hidden="true" size={20} />
            <div>
              <h3>Payment status</h3>
              <p>
                Submitting and Confirming mean the automation is being created. Waiting means it is
                ready for its scheduled time. Processing means payment is underway, and Completed
                means it has finished.
              </p>
            </div>
          </article>
          <article>
            <RotateCcw aria-hidden="true" size={20} />
            <div>
              <h3>Manage an automation</h3>
              <p>
                Open an automation to view its payment details and activity. When available, the
                owner can cancel it, add funds, or recover the remaining funds.
              </p>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
