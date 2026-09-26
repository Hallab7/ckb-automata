"use client";

import {
  ArrowUpRight,
  CircleCheck,
  CircleDollarSign,
  Clock3,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { Amount, Button, InlineNotice, SelectField } from "@ckb-automata/ui";

import { calendarDateParts, formatDateTime } from "../time/chain-time.ts";

import {
  dashboardJobPresentation,
  dashboardSummary,
  shortJobId,
  type DashboardJob,
  type DashboardStatus,
  type RecipientAmountsByJob,
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
  needs_funding: { icon: CircleDollarSign, label: "Needs funding", tone: "warning" },
  processing: { icon: LoaderCircle, label: "Processing", tone: "success" },
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

function Summary({
  items,
  recipientAmounts,
}: Readonly<{ items: readonly DashboardJob[]; recipientAmounts: RecipientAmountsByJob }>) {
  const summary = dashboardSummary(items, recipientAmounts);
  return (
    <section className="automation-funds" aria-label="Loaded automation summary">
      <div className="automation-funds__heading">
        <div>
          <span>Recipient amount scheduled</span>
          <strong>{summary.recipientTotal}</strong>
          <small>Across the automations currently loaded</small>
        </div>
        <div className="automation-funds__count">
          <strong>{summary.total.toLocaleString("en-US")}</strong>
          <span>automations</span>
        </div>
      </div>
      <div aria-hidden="true" className="automation-distribution">
        <span data-state="live" style={{ flexGrow: summary.live }} />
        <span data-state="spent" style={{ flexGrow: summary.spent }} />
        <span data-state="orphaned" style={{ flexGrow: summary.orphaned }} />
      </div>
      <dl className="automation-legend">
        <div data-state="live">
          <dt>Live</dt>
          <dd>{summary.live.toLocaleString("en-US")}</dd>
        </div>
        <div data-state="spent">
          <dt>Completed</dt>
          <dd>{summary.spent.toLocaleString("en-US")}</dd>
        </div>
        <div data-state="orphaned">
          <dt>Reorged</dt>
          <dd>{summary.orphaned.toLocaleString("en-US")}</dd>
        </div>
      </dl>
    </section>
  );
}

function NextAutomation({
  checkpointAt,
  checkpointBlock,
  items,
  recipientAmounts,
  titles,
}: Readonly<{
  checkpointAt: string | undefined;
  checkpointBlock: string | undefined;
  items: readonly DashboardJob[];
  recipientAmounts: RecipientAmountsByJob;
  titles: Readonly<Record<string, string>>;
}>) {
  const liveJobs = items.filter((item) => item.state === "live");
  const job =
    liveJobs.find(
      (item) =>
        dashboardJobPresentation(item, checkpointBlock, recipientAmounts[item.jobId], checkpointAt)
          .status === "waiting",
    ) ??
    liveJobs[0] ??
    items[0];
  if (job === undefined) return null;
  const presentation = dashboardJobPresentation(
    job,
    checkpointBlock,
    recipientAmounts[job.jobId],
    checkpointAt,
  );
  const title =
    titles[job.jobId] ??
    (job.template === "deadline" ? "Scheduled payment" : "Recurring distribution");
  const calendar = calendarDateParts(presentation.scheduledAt);

  return (
    <section className="automation-next" aria-labelledby="next-automation-title">
      <div className="automation-next__heading">
        <span>Next scheduled payment</span>
        <DashboardStatusBadge status={presentation.status} />
      </div>
      <div className="automation-next__identity">
        <span aria-hidden="true" className="automation-date-tile automation-date-tile--large">
          <small>{calendar.month}</small>
          <strong>{calendar.day}</strong>
        </span>
        <div>
          <h2 id="next-automation-title">{title}</h2>
          <p>{presentation.nextSchedule}</p>
        </div>
      </div>
      <div className="automation-next__details">
        <div>
          <span>Recipient amount</span>
          <strong>{presentation.recipientAmount}</strong>
        </div>
        <div>
          <span>Time remaining</span>
          <strong>{presentation.timeRemaining}</strong>
        </div>
        <Link
          aria-label={`Open ${title}`}
          className="ui-icon-button ui-icon-button--secondary"
          href={`/automations/${encodeURIComponent(job.jobId)}`}
        >
          <ArrowUpRight aria-hidden="true" size={16} />
        </Link>
      </div>
    </section>
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
  checkpointAt,
  checkpointBlock,
  items,
  recipientAmounts,
  titles,
}: Readonly<{
  checkpointAt: string | undefined;
  checkpointBlock: string | undefined;
  items: readonly DashboardJob[];
  recipientAmounts: RecipientAmountsByJob;
  titles: Readonly<Record<string, string>>;
}>) {
  return (
    <div className="automation-list">
      <div aria-hidden="true" className="automation-list__header">
        <span>Date</span>
        <span>Automation</span>
        <span>Status</span>
        <span>Next schedule</span>
        <span>Recipient amount</span>
        <span />
      </div>
      {items.map((job) => {
        const presentation = dashboardJobPresentation(
          job,
          checkpointBlock,
          recipientAmounts[job.jobId],
          checkpointAt,
        );
        const calendar = calendarDateParts(presentation.scheduledAt);
        return (
          <Link
            aria-label={`Open ${job.template} automation ${job.jobId}`}
            className="automation-row"
            href={`/automations/${encodeURIComponent(job.jobId)}`}
            key={`${job.jobId}:${job.source.outPoint.txHash}:${job.source.outPoint.index}`}
          >
            <span aria-hidden="true" className="automation-row__template automation-date-tile">
              <small>{calendar.month}</small>
              <strong>{calendar.day}</strong>
            </span>
            <div className="automation-row__identity">
              <strong>
                {titles[job.jobId] ??
                  (job.template === "deadline" ? "Scheduled payment" : "Recurring distribution")}
              </strong>
              <code title={job.jobId}>{shortJobId(job.jobId)}</code>
            </div>
            <div className="automation-row__status">
              <DashboardStatusBadge status={presentation.status} />
              <span>{presentation.nextAction}</span>
            </div>
            <div className="automation-row__detail">
              <span className="automation-row__mobile-label">Next schedule</span>
              <strong>{presentation.nextSchedule}</strong>
              <span>{job.template === "deadline" ? "Scheduled payment" : "Recurring payment"}</span>
            </div>
            <div className="automation-row__amount">
              <span className="automation-row__mobile-label">Recipient amount</span>
              <Amount>{presentation.recipientAmount}</Amount>
              <span>{presentation.runsRemaining} runs remaining</span>
            </div>
            <MoreHorizontal aria-hidden="true" className="automation-row__arrow" size={17} />
          </Link>
        );
      })}
    </div>
  );
}

export interface AutomationDashboardViewProperties {
  readonly checkpointAt?: string | undefined;
  readonly checkpointBlock?: string | undefined;
  readonly dataSourceLabel?: string | undefined;
  readonly error?: string | undefined;
  readonly hasNextPage?: boolean | undefined;
  readonly items: readonly DashboardJob[];
  readonly loadState: DashboardLoadState;
  readonly loadingNextPage?: boolean | undefined;
  readonly mode: DashboardMode;
  readonly recipientAmounts?: RecipientAmountsByJob | undefined;
  readonly onConnect?: (() => void) | undefined;
  readonly onLoadNext?: (() => void) | undefined;
  readonly onModeChange: (mode: DashboardMode) => void;
  readonly onRetry?: (() => void) | undefined;
  readonly onStateChange: (state: string) => void;
  readonly onTemplateChange: (template: string) => void;
  readonly stateFilter: string;
  readonly templateFilter: string;
  readonly titles?: Readonly<Record<string, string>> | undefined;
}

export function AutomationDashboardView({
  checkpointAt,
  checkpointBlock,
  dataSourceLabel,
  error,
  hasNextPage = false,
  items,
  loadState,
  loadingNextPage = false,
  mode,
  recipientAmounts = {},
  onConnect,
  onLoadNext,
  onModeChange,
  onRetry,
  onStateChange,
  onTemplateChange,
  stateFilter,
  templateFilter,
  titles = {},
}: AutomationDashboardViewProperties) {
  return (
    <section className="app-page automation-dashboard" aria-labelledby="page-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <span className="app-page-header__eyebrow">Automation workspace</span>
          <h1 id="page-title">Automations</h1>
          <p>Monitor scheduled and recurring payments from one clear workspace.</p>
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

      {items.length > 0 ? (
        <div className="automation-overview">
          <Summary items={items} recipientAmounts={recipientAmounts} />
          <NextAutomation
            checkpointAt={checkpointAt}
            checkpointBlock={checkpointBlock}
            items={items}
            recipientAmounts={recipientAmounts}
            titles={titles}
          />
        </div>
      ) : null}

      <section className="automation-surface" aria-label="Automation records">
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
              Public testnet
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
              label="Automation type"
              onChange={(event) => onTemplateChange(event.target.value)}
              value={templateFilter}
            >
              <option value="">All automation types</option>
              <option value="deadline">Scheduled payment</option>
              <option value="recurring">Recurring payment</option>
            </SelectField>
          </div>
        </div>
        <header className="automation-surface__heading">
          <strong>Payment automations</strong>
          <span>
            {items.length === 0
              ? "CKB Pudge Testnet schedule"
              : `Synced ${formatDateTime(
                  items.reduce(
                    (latest, item) =>
                      Date.parse(item.updatedAt) > Date.parse(latest) ? item.updatedAt : latest,
                    items[0]!.updatedAt,
                  ),
                )}`}
          </span>
        </header>

        {loadState === "loading" ? <LoadingRows /> : null}
        {loadState === "owner_required" ? (
          <div className="automation-surface__state">
            <InlineNotice title="Connect your owner wallet" tone="warning">
              <p>
                The owner view uses the connected testnet lock hash. Public testnet records remain
                available without a wallet.
              </p>
              <Button onClick={onConnect} tone="secondary">
                Connect wallet
              </Button>
            </InlineNotice>
          </div>
        ) : null}
        {loadState === "error" ? (
          <div className="automation-surface__state">
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
          </div>
        ) : null}
        {loadState === "ready" && items.length === 0 ? (
          <div className="app-empty-state">
            <h2>
              {mode === "owner" ? "No automations for this wallet" : "No public automations found"}
            </h2>
            <p>Adjust the filters or create a testnet automation.</p>
          </div>
        ) : null}
        {items.length > 0 ? (
          <AutomationRows
            checkpointAt={checkpointAt}
            checkpointBlock={checkpointBlock}
            items={items}
            recipientAmounts={recipientAmounts}
            titles={titles}
          />
        ) : null}
        {hasNextPage ? (
          <div className="automation-pagination">
            <Button disabled={loadingNextPage} onClick={onLoadNext} tone="secondary">
              {loadingNextPage ? "Loading..." : "Load next page"}
            </Button>
          </div>
        ) : null}
        <footer className="automation-surface__footer">
          <span>{dataSourceLabel ?? "Live testnet index"}</span>
          <span>{items.length.toLocaleString("en-US")} loaded</span>
        </footer>
      </section>
    </section>
  );
}
