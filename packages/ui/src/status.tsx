import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  RotateCcw,
  Send,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { CanonicalTransactionState } from "@ckb-automata/core";

import { TRANSACTION_STATE_LABELS } from "./labels.ts";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusPresentation {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone: StatusTone;
}

const STATUS_PRESENTATIONS = {
  draft: { icon: CircleDashed, tone: "neutral" },
  awaiting_signature: { icon: Clock3, tone: "warning" },
  submitted: { icon: Send, tone: "info" },
  proposed: { icon: Clock3, tone: "info" },
  committed: { icon: CircleCheck, tone: "success" },
  confirmed: { icon: CircleCheck, tone: "success" },
  conflicted: { icon: CircleX, tone: "danger" },
  dropped: { icon: CircleX, tone: "danger" },
  cancelled: { icon: CircleDashed, tone: "neutral" },
  recovery_required: { icon: ShieldAlert, tone: "warning" },
  reorged: { icon: RotateCcw, tone: "warning" },
} as const satisfies Record<
  CanonicalTransactionState,
  Readonly<{ icon: LucideIcon; tone: StatusTone }>
>;

export function statusPresentation(state: CanonicalTransactionState): StatusPresentation {
  return Object.freeze({ ...STATUS_PRESENTATIONS[state], label: TRANSACTION_STATE_LABELS[state] });
}

export function StatusBadge({ state }: Readonly<{ state: CanonicalTransactionState }>) {
  const presentation = statusPresentation(state);
  const Icon = presentation.icon;
  return (
    <span className={`ui-status ui-status--${presentation.tone}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2.25} />
      <span>{presentation.label}</span>
    </span>
  );
}

export function InlineNotice({
  children,
  title,
  tone = "info",
}: Readonly<{ children: ReactNode; title: string; tone?: StatusTone }>) {
  const Icon = tone === "danger" || tone === "warning" ? CircleAlert : CircleCheck;
  return (
    <div className={`ui-notice ui-notice--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </div>
  );
}
