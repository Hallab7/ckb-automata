"use client";

import {
  CircleCheck,
  CircleDollarSign,
  Clock3,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { Amount, Button, InlineNotice, SelectField } from "@ckb-automata/ui";

import {
  dashboardJobPresentation,
  dashboardSummary,
  shortJobId,
  type DashboardJob,
  type DashboardStatus,
} from "./dashboard-model.ts";

export type DashboardMode = "owner" | "public";
export type DashboardLoadState = "error" | "loading" | "owner_required" | "ready";

interface DashboardStatusPresentation {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone: "danger" | "info" | "neutral" | "success" | "warning";
}

const DASHBOARD_STATUS: Record<DashboardStatus, DashboardStatusPresentation> = {
  completed: { icon: CircleCheck, label: "Completed", tone: "neutral" },
  eligible: { icon: Zap, label: "Eligible", tone: "success" },
  needs_funding: { icon: CircleDollarSign, label: "Needs funding", tone: "warning" },
  recovery_required: { icon: ShieldAlert, label: "Recovery required", tone: "danger" },
  reorged: { icon: RotateCcw, label: "Reorged", tone: "warning" },
  waiting: { icon: Clock3, label: "Waiting", tone: "info" },
};

function DashboardStatusBadge({ status }: Readonly<{ status: DashboardStatus }>) {
  const presentation = DASHBOARD_STATUS[status];
  const Icon = presentation.icon;
  return (
    <span className={`ui-status ui-status--${presentation.tone}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2.25} />
      <span>{presentation.label}</span>
    </span>
  );
}

function Summary({ items }: Readonly<{ items: readonly DashboardJob[] }>) {
  const summary = dashboardSummary(items);
  const values = [
    ["Loaded", summary.total.toLocaleString("en-US")],
    ["Live", summary.live.toLocaleString("en-US")],
    ["Completed", summary.spent.toLocaleString("en-US")],
    ["Reorged", summary.orphaned.toLocaleString("en-US")],
    ["Funded value", summary.fundedValue],
  ] as const;
  return (
    <dl className="automation-summary" aria-label="Loaded automation summary">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LoadingRows() {
  return (
    <div className="automation-loading" aria-label="Loading automations" aria-live="polite">
      {[0, 1, 2].map((row) => (
        <div aria-hidden="true" className="automation-loading__row" key={row} />
      ))}
      <span className="ui-sr-only">Loading automations</span>
    </div>
  );
}

function AutomationRows({
  checkpointBlock,
  items,
}: Readonly<{ checkpointBlock: string | undefined; items: readonly DashboardJob[] }>) {
  return (
    <div className="automation-list">
      <div aria-hidden="true" className="automation-list__header">
        <span>Automation</span>
        <span>Status</span>
        <span>Next eligibility</span>
        <span>Funded value</span>
      </div>
      {items.map((job) => {
        const presentation = dashboardJobPresentation(job, checkpointBlock);
        return (
          <Link
            aria-label={`Open ${job.template} automation ${job.jobId}`}
            className="automation-row"
            href={`/automations/${encodeURIComponent(job.jobId)}`}
            key={`${job.jobId}:${job.source.outPoint.txHash}:${job.source.outPoint.index}`}
          >
            <div className="automation-row__identity">
              <strong>
                {job.template === "deadline" ? "Deadline finalization" : "Recurring distribution"}
              </strong>
              <code title={job.jobId}>{shortJobId(job.jobId)}</code>
            </div>
            <div className="automation-row__status">
              <DashboardStatusBadge status={presentation.status} />
              <span>{presentation.nextAction}</span>
            </div>
            <div className="automation-row__detail">
              <span className="automation-row__mobile-label">Next eligibility</span>
              <strong>{presentation.nextEligibility}</strong>
              <span>{job.remainingRuns} runs remaining</span>
            </div>
            <div className="automation-row__amount">
              <span className="automation-row__mobile-label">Funded value</span>
              <Amount>{presentation.fundedValue}</Amount>
              <span>Sequence {job.sequence}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export interface AutomationDashboardViewProperties {
  readonly checkpointBlock?: string | undefined;
  readonly error?: string | undefined;
  readonly hasNextPage?: boolean | undefined;
  readonly items: readonly DashboardJob[];
  readonly loadState: DashboardLoadState;
  readonly loadingNextPage?: boolean | undefined;
  readonly mode: DashboardMode;
  readonly onConnect?: (() => void) | undefined;
  readonly onLoadNext?: (() => void) | undefined;
  readonly onModeChange: (mode: DashboardMode) => void;
  readonly onRetry?: (() => void) | undefined;
  readonly onStateChange: (state: string) => void;
  readonly onTemplateChange: (template: string) => void;
  readonly stateFilter: string;
  readonly templateFilter: string;
}

export function AutomationDashboardView({
  checkpointBlock,
  error,
  hasNextPage = false,
  items,
  loadState,
  loadingNextPage = false,
  mode,
  onConnect,
  onLoadNext,
  onModeChange,
  onRetry,
  onStateChange,
  onTemplateChange,
  stateFilter,
  templateFilter,
}: AutomationDashboardViewProperties) {
  return (
    <section className="app-page automation-dashboard" aria-labelledby="page-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <h1 id="page-title">Automations</h1>
          <p>
            {checkpointBlock === undefined
              ? "CKB Pudge Testnet job state"
              : `Indexed through block #${BigInt(checkpointBlock).toLocaleString("en-US")}`}
          </p>
        </div>
        <div className="app-page-header__actions">
          <Link className="ui-button ui-button--primary" href="/automations/new">
            <span className="ui-button__icon">
              <Plus aria-hidden="true" size={17} />
            </span>
            <span className="ui-button__label">New automation</span>
          </Link>
        </div>
      </header>

      <div className="automation-toolbar">
        <div aria-label="Automation ownership" className="automation-mode" role="group">
          <button
            aria-pressed={mode === "owner"}
            onClick={() => onModeChange("owner")}
            type="button"
          >
            My automations
          </button>
          <button
            aria-pressed={mode === "public"}
            onClick={() => onModeChange("public")}
            type="button"
          >
            Public demo
          </button>
        </div>
        <div className="automation-filters">
          <SelectField
            label="Lifecycle"
            onChange={(event) => onStateChange(event.target.value)}
            value={stateFilter}
          >
            <option value="">All lifecycle states</option>
            <option value="live">Live</option>
            <option value="spent">Completed</option>
            <option value="orphaned">Orphaned</option>
          </SelectField>
          <SelectField
            label="Template"
            onChange={(event) => onTemplateChange(event.target.value)}
            value={templateFilter}
          >
            <option value="">All templates</option>
            <option value="deadline">Deadline finalization</option>
            <option value="recurring">Recurring distribution</option>
          </SelectField>
        </div>
      </div>

      {items.length > 0 ? <Summary items={items} /> : null}

      {loadState === "loading" ? <LoadingRows /> : null}
      {loadState === "owner_required" ? (
        <InlineNotice title="Connect your owner wallet" tone="warning">
          <p>
            The owner view uses the connected testnet lock hash. The public demo remains available
            without a wallet.
          </p>
          <Button onClick={onConnect} tone="secondary">
            Connect wallet
          </Button>
        </InlineNotice>
      ) : null}
      {loadState === "error" ? (
        <InlineNotice title="Automations unavailable" tone="danger">
          <p>{error ?? "The job index could not be read."}</p>
          <Button
            icon={<RefreshCw aria-hidden="true" size={16} />}
            onClick={onRetry}
            tone="secondary"
          >
            Retry
          </Button>
        </InlineNotice>
      ) : null}
      {loadState === "ready" && items.length === 0 ? (
        <div className="app-empty-state">
          <h2>
            {mode === "owner" ? "No automations for this wallet" : "No public automations found"}
          </h2>
          <p>Adjust the filters or create a testnet automation.</p>
        </div>
      ) : null}
      {items.length > 0 ? <AutomationRows checkpointBlock={checkpointBlock} items={items} /> : null}
      {hasNextPage ? (
        <div className="automation-pagination">
          <Button disabled={loadingNextPage} onClick={onLoadNext} tone="secondary">
            {loadingNextPage ? "Loading..." : "Load next page"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
