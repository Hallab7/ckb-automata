"use client";

import {
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Landmark,
  ListChecks,
  LockKeyhole,
  Repeat2,
  RotateCcw,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";

type GuideId = "harvest" | "recurring" | "scheduled";

interface GuideStep {
  readonly description: string;
  readonly icon: LucideIcon;
  readonly title: string;
}

interface Guide {
  readonly description: string;
  readonly icon: LucideIcon;
  readonly id: GuideId;
  readonly label: string;
  readonly note?: string;
  readonly steps: readonly GuideStep[];
}

const GUIDES: readonly Guide[] = [
  {
    description: "Send one CKB payment at a future date and time.",
    icon: CalendarClock,
    id: "scheduled",
    label: "Scheduled payment",
    steps: [
      {
        description:
          "Add an optional title, the amount, and the address that should receive the payment.",
        icon: WalletCards,
        title: "Enter the payment details",
      },
      {
        description:
          "Select a future date and time. CKAutomata uses it to determine when the payment can be processed.",
        icon: CalendarClock,
        title: "Choose when it should happen",
      },
      {
        description:
          "Choose whether the recipient should be paid or the amount should return to your refund address when the condition is checked.",
        icon: ListChecks,
        title: "Choose the outcome",
      },
      {
        description:
          "Check the recipient amount, combined charges, and total deposit. Your wallet shows the exact transaction before you approve it.",
        icon: LockKeyhole,
        title: "Review and approve",
      },
      {
        description:
          "The payment remains protected until its scheduled time. Open Automations to follow it from Waiting to Processing and Completed.",
        icon: CheckCircle2,
        title: "Track the payment",
      },
    ],
  },
  {
    description: "Send the same CKB amount several times on a schedule you choose.",
    icon: Repeat2,
    id: "recurring",
    label: "Recurring distribution",
    steps: [
      {
        description:
          "Add an optional title, the amount for each payment, and the recipient address.",
        icon: WalletCards,
        title: "Enter the payment details",
      },
      {
        description: "Choose the future date and time when the first payment should be ready.",
        icon: CalendarClock,
        title: "Set the first payment",
      },
      {
        description:
          "Choose how often the payment repeats and the total number of payments. The automation stops after the final one.",
        icon: Repeat2,
        title: "Choose the repeat schedule",
      },
      {
        description:
          "Check the amount for every payment, combined charges, and total deposit before approving the exact transaction in your wallet.",
        icon: LockKeyhole,
        title: "Review and approve",
      },
      {
        description:
          "CKAutomata releases one payment at each scheduled time. You can follow completed payments and the next payment from Automations.",
        icon: CheckCircle2,
        title: "Follow each payment",
      },
    ],
  },
  {
    description:
      "Collect earned Nervos DAO compensation and place your original amount back into a new DAO deposit.",
    icon: Landmark,
    id: "harvest",
    label: "DAO harvest",
    note: "Harvesting does not increase the DAO earning rate. It collects earned compensation so you do not have to track withdrawal cycles yourself.",
    steps: [
      {
        description:
          "Choose the original CKB amount that should remain in the DAO and the address that should receive the earned compensation.",
        icon: Landmark,
        title: "Choose the deposit",
      },
      {
        description:
          "Choose one harvest or a fixed number of harvests. The automation cannot add more harvests later.",
        icon: Repeat2,
        title: "Choose how many harvests",
      },
      {
        description:
          "Review the original amount, automation charges, and total deposit. Your wallet approves only these exact terms.",
        icon: LockKeyhole,
        title: "Review and approve",
      },
      {
        description:
          "CKAutomata waits for the correct DAO withdrawal window, prepares the withdrawal, and then waits for the required maturity period.",
        icon: CalendarClock,
        title: "Wait for the DAO cycle",
      },
      {
        description:
          "The earned compensation goes to your chosen address while the exact original amount enters a new DAO deposit. The process repeats only if you selected more harvests.",
        icon: CircleDollarSign,
        title: "Receive the compensation",
      },
    ],
  },
] as const;

export function HowItWorksTabs() {
  const [activeId, setActiveId] = useState<GuideId>("scheduled");
  const activeGuide = GUIDES.find((guide) => guide.id === activeId) ?? GUIDES[0]!;

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % GUIDES.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + GUIDES.length) % GUIDES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = GUIDES.length - 1;
    }
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextGuide = GUIDES[nextIndex]!;
    setActiveId(nextGuide.id);
    document.getElementById(`how-it-works-tab-${nextGuide.id}`)?.focus();
  };

  return (
    <section className="how-it-works-guide" aria-label="Automation guides">
      <div aria-label="Choose an automation guide" className="how-it-works-tabs" role="tablist">
        {GUIDES.map(({ icon: Icon, id, label }, index) => (
          <button
            aria-controls={`how-it-works-panel-${id}`}
            aria-selected={activeId === id}
            id={`how-it-works-tab-${id}`}
            key={id}
            onClick={() => setActiveId(id)}
            onKeyDown={(event) => moveTabFocus(event, index)}
            role="tab"
            tabIndex={activeId === id ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden="true" size={17} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`how-it-works-tab-${activeGuide.id}`}
        className="how-it-works-panel"
        id={`how-it-works-panel-${activeGuide.id}`}
        role="tabpanel"
      >
        <header className="how-it-works-panel__header">
          <span className="how-it-works-panel__icon">
            <activeGuide.icon aria-hidden="true" size={20} />
          </span>
          <div>
            <h2>{activeGuide.label}</h2>
            <p>{activeGuide.description}</p>
          </div>
        </header>

        <ol aria-label={`${activeGuide.label} steps`} className="how-it-works-flow">
          {activeGuide.steps.map(({ description, icon: Icon, title }, index) => (
            <li key={title}>
              <div aria-hidden="true" className="how-it-works-flow__marker">
                <Icon size={20} />
              </div>
              <div className="how-it-works-flow__copy">
                <span>Step {index + 1}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </div>
            </li>
          ))}
        </ol>

        {activeGuide.note === undefined ? null : (
          <div className="how-it-works-panel__note">
            <RotateCcw aria-hidden="true" size={18} />
            <p>{activeGuide.note}</p>
          </div>
        )}
      </div>
    </section>
  );
}
