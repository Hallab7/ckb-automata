"use client";

import {
  Activity,
  ArrowLeft,
  Blocks,
  CheckCircle2,
  CircleDollarSign,
  CircleOff,
  CircleX,
  Clock3,
  ExternalLink,
  FileCheck2,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { ApiJob, ApiJobEvents } from "@ckb-automata/api-client";
import { CANONICAL_TRANSACTION_STATES, type CanonicalTransactionState } from "@ckb-automata/core";
import { Amount, Button, InlineNotice, StatusBadge } from "@ckb-automata/ui";

import { ckbTestnetBlockUrl, ckbTestnetTransactionUrl } from "../ccc/wallet-display.ts";
import { formatDateTime } from "../time/chain-time.ts";
import {
  eventLabel,
  jobDetailPresentation,
  jobScheduleDate,
  type DetailEvent,
  type JobDetailStatus,
} from "./job-detail-model.ts";

export type JobDetailLoadState = "error" | "loading" | "not_found" | "ready";

interface DetailStatusPresentation {
  readonly icon: LucideIcon;
  readonly tone: "danger" | "info" | "neutral" | "success" | "warning";
}

const detailStatuses: Readonly<Record<JobDetailStatus, DetailStatusPresentation>> = {
  cancelled: { icon: CircleOff, tone: "neutral" },
  completed: { icon: CheckCircle2, tone: "neutral" },
  conflicted: { icon: ShieldAlert, tone: "danger" },
  dropped: { icon: CircleX, tone: "danger" },
  processing: { icon: LoaderCircle, tone: "success" },
  needs_funding: { icon: CircleDollarSign, tone: "warning" },
  recovery_required: { icon: ShieldAlert, tone: "danger" },
  reorged: { icon: RotateCcw, tone: "warning" },
  unsupported: { icon: TriangleAlert, tone: "warning" },
  waiting: { icon: Clock3, tone: "info" },
};

function DetailStatus({ label, status }: Readonly<{ label: string; status: JobDetailStatus }>) {
  const presentation = detailStatuses[status];
  const Icon = presentation.icon;
  return (
    <span className={`ui-status ui-status--${presentation.tone}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2.25} />
      <span>{label}</span>
    </span>
  );
}

function ExplorerLink({ children, href }: Readonly<{ children: React.ReactNode; href: string }>) {
  return (
    <a className="job-detail__explorer" href={href} rel="noreferrer" target="_blank">
      {children}
      <ExternalLink aria-hidden="true" size={14} />
    </a>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function canonicalAttemptState(state: string): CanonicalTransactionState | undefined {
  return CANONICAL_TRANSACTION_STATES.includes(state as CanonicalTransactionState)
    ? (state as CanonicalTransactionState)
    : undefined;
}

function confidenceTone(confidence: DetailEvent["confidence"]): string {
  if (confidence === "confirmed") return "success";
  if (confidence === "reorged") return "warning";
  if (confidence === "committed") return "info";
  return "neutral";
}

function EventTimelineItem({ event }: Readonly<{ event: DetailEvent }>) {
  const attemptState =
    event.attempt === null ? undefined : canonicalAttemptState(event.attempt.state);
  return (
    <li className="job-event" data-event-confidence={event.confidence}>
      <span className="job-event__marker" aria-hidden="true">
        {event.category === "transaction" ? <Blocks size={16} /> : <Activity size={16} />}
      </span>
      <div className="job-event__body">
        <div className="job-event__heading">
          <div>
            <h3>{eventLabel(event.eventType)}</h3>
            <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)} UTC</time>
          </div>
          <span className={`ui-status ui-status--${confidenceTone(event.confidence)}`}>
            {event.confidence}
          </span>
        </div>

        {event.block === null ? (
          <p className="job-event__provenance">Operational observation, not a canonical result.</p>
        ) : (
          <div className="job-event__links">
            <ExplorerLink href={ckbTestnetBlockUrl(event.block.number)}>
              Confirmed {formatDateTime(event.occurredAt)}
            </ExplorerLink>
            <ExplorerLink href={ckbTestnetTransactionUrl(event.block.transactionHash)}>
              Transaction
            </ExplorerLink>
          </div>
        )}

        {event.replacement === null ? null : (
          <p className="job-event__replacement">
            Replaced by {eventLabel(event.replacement.eventType)} in{" "}
            <ExplorerLink href={ckbTestnetTransactionUrl(event.replacement.transactionHash)}>
              transaction {event.replacement.transactionHash.slice(0, 10)}...
            </ExplorerLink>
          </p>
        )}

        {event.attempt === null ? null : (
          <dl className="job-event__attempt">
            <div>
              <dt>Attempt</dt>
              <dd>{event.attempt.operation.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd>
                {attemptState === undefined ? (
                  event.attempt.state
                ) : (
                  <StatusBadge state={attemptState} />
                )}
              </dd>
            </div>
            <div>
              <dt>Transaction</dt>
              <dd>
                {event.attempt.transactionHash === null ? (
                  "Not submitted"
                ) : (
                  <ExplorerLink href={ckbTestnetTransactionUrl(event.attempt.transactionHash)}>
                    View transaction
                  </ExplorerLink>
                )}
              </dd>
            </div>
          </dl>
        )}

        {event.attempt?.receipt === null || event.attempt?.receipt === undefined ? null : (
          <details className="job-event__receipt">
            <summary>
              <FileCheck2 aria-hidden="true" size={16} />
              Verified executor receipt
            </summary>
            <dl>
              <div>
                <dt>Receipt ID</dt>
                <dd>{event.attempt.receipt.id}</dd>
              </div>
              <div>
                <dt>Executor lock</dt>
                <dd>{event.attempt.receipt.executorLockHash}</dd>
              </div>
              <div>
                <dt>Key ID</dt>
                <dd>{event.attempt.receipt.keyId}</dd>
              </div>
            </dl>
            <pre>{JSON.stringify(event.attempt.receipt.payload, null, 2)}</pre>
            <p className="job-event__signature">
              Signature <code>{event.attempt.receipt.signature}</code>
            </p>
          </details>
        )}

        {Object.keys(event.details).length === 0 ? null : (
          <details className="job-event__payload">
            <summary>Event payload</summary>
            <pre>{JSON.stringify(event.details, null, 2)}</pre>
          </details>
        )}
      </div>
    </li>
  );
}

export function AutomationDetailSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading automation details"
      className="app-page job-detail job-detail-loading"
    >
      <span className="ui-sr-only">Loading automation details</span>
      <header aria-hidden="true" className="job-detail-loading__header">
        <span />
        <span />
        <span />
      </header>
      <div aria-hidden="true" className="job-detail-loading__summary">
        {[0, 1, 2, 3].map((item) => (
          <span key={item} />
        ))}
      </div>
      <div aria-hidden="true" className="job-detail-loading__columns">
        {[0, 1].map((item) => (
          <section key={item}>
            <span />
            <span />
            <span />
          </section>
        ))}
      </div>
      <section aria-hidden="true" className="job-detail-loading__activity">
        <span />
        <span />
        <span />
      </section>
    </section>
  );
}

export interface JobDetailViewProperties {
  readonly automationTitle?: string;
  readonly checkpointAt?: string;
  readonly error?: string;
  readonly events: ApiJobEvents["items"];
  readonly hasNextPage?: boolean;
  readonly job?: ApiJob;
  readonly loadState: JobDetailLoadState;
  readonly loadingNextPage?: boolean;
  readonly onLoadNext?: () => void;
  readonly onRetry?: () => void;
  readonly ownerActions?: ReactNode;
  readonly recipientAmount?: string;
  readonly referenceBlock?: string;
}

export function JobDetailView({
  automationTitle,
  checkpointAt,
  error,
  events,
  hasNextPage = false,
  job,
  loadState,
  loadingNextPage = false,
  onLoadNext,
  onRetry,
  ownerActions,
  recipientAmount,
  referenceBlock,
}: JobDetailViewProperties) {
  if (loadState === "loading") return <AutomationDetailSkeleton />;
  if (loadState === "not_found") {
    return (
      <section className="app-page job-detail-empty">
        <InlineNotice title="Automation not found" tone="warning">
          <p>This job is not present at the current canonical index checkpoint.</p>
        </InlineNotice>
        <Link className="ui-button ui-button--secondary" href="/automations">
          <ArrowLeft aria-hidden="true" size={16} /> Automations
        </Link>
      </section>
    );
  }
  if (loadState === "error" || job === undefined) {
    return (
      <section className="app-page job-detail-empty">
        <InlineNotice title="Automation details unavailable" tone="danger">
          <p>{error ?? "The canonical job detail could not be loaded."}</p>
          <Button
            icon={<RefreshCw aria-hidden="true" size={16} />}
            onClick={onRetry}
            tone="secondary"
          >
            Retry
          </Button>
        </InlineNotice>
      </section>
    );
  }

  const presentation = jobDetailPresentation(
    job,
    events,
    recipientAmount,
    checkpointAt,
    referenceBlock,
  );
  return (
    <article className="app-page job-detail" aria-labelledby="job-detail-title">
      <header className="job-detail__header">
        <Link className="job-detail__back" href="/automations">
          <ArrowLeft aria-hidden="true" size={16} /> Automations
        </Link>
        <div className="job-detail__title-row">
          <div>
            <p>
              {automationTitle === undefined
                ? "Automation details"
                : job.template === "recurring"
                  ? "Recurring payments"
                  : "Scheduled payment"}
            </p>
            <h1 id="job-detail-title">{automationTitle ?? presentation.policyName}</h1>
          </div>
          <DetailStatus label={presentation.statusLabel} status={presentation.status} />
        </div>
      </header>

      <dl className="job-detail__summary">
        <div>
          <dt>Recipient amount</dt>
          <dd>
            <Amount>{presentation.recipientAmount}</Amount>
          </dd>
        </div>
        <div>
          <dt>Payments sent</dt>
          <dd>{job.sequence}</dd>
        </div>
        <div>
          <dt>Payments left</dt>
          <dd>{presentation.runsRemaining}</dd>
        </div>
        <div>
          <dt>Next payment</dt>
          <dd>{presentation.nextExecution}</dd>
        </div>
      </dl>

      {ownerActions}

      <div className="job-detail__columns">
        <section className="job-detail__section" aria-labelledby="policy-heading">
          <div className="job-detail__section-heading">
            <h2 id="policy-heading">Schedule</h2>
            <p>{presentation.nextAction}</p>
          </div>
          <dl className="job-detail__facts">
            <div>
              <dt>Next scheduled payment</dt>
              <dd>{jobScheduleDate(job, job.trigger.notBefore, checkpointAt, referenceBlock)}</dd>
            </div>
            <div>
              <dt>End date</dt>
              <dd>
                {job.trigger.notAfter === "0"
                  ? "No end date"
                  : jobScheduleDate(job, job.trigger.notAfter, checkpointAt, referenceBlock)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="job-detail__section" aria-labelledby="funds-heading">
          <div className="job-detail__section-heading">
            <h2 id="funds-heading">Funds</h2>
            <p>CKB currently held for this automation.</p>
          </div>
          <dl className="job-detail__facts">
            <div>
              <dt>Total held</dt>
              <dd>{presentation.automationReserve}</dd>
            </div>
            <div>
              <dt>Service budget left</dt>
              <dd>{presentation.remainingBudget}</dd>
            </div>
            <div>
              <dt>Service payment</dt>
              <dd>{presentation.executorReward}</dd>
            </div>
          </dl>
          <ExplorerLink href={ckbTestnetTransactionUrl(job.source.outPoint.txHash)}>
            Open source transaction
          </ExplorerLink>
        </section>
      </div>

      <section
        className="job-detail__section job-detail__timeline"
        aria-labelledby="timeline-heading"
      >
        <div className="job-detail__section-heading">
          <h2 id="timeline-heading">Activity</h2>
          <p>
            {job.source.indexCheckpoint === null
              ? "Latest sync time unavailable"
              : `Updated ${formatDateTime(job.updatedAt)}`}
          </p>
        </div>
        {error === undefined ? null : (
          <InlineNotice title="Timeline update delayed" tone="warning">
            <p>{error}</p>
          </InlineNotice>
        )}
        {events.length === 0 ? (
          <div className="app-empty-state">
            <History aria-hidden="true" size={22} />
            <h3>No events recorded</h3>
            <p>The job exists, but its public event timeline is empty.</p>
          </div>
        ) : (
          <ol className="job-timeline">
            {events.map((event) => (
              <EventTimelineItem event={event} key={event.eventId} />
            ))}
          </ol>
        )}
        {hasNextPage ? (
          <Button disabled={loadingNextPage} onClick={onLoadNext} tone="secondary">
            {loadingNextPage ? "Loading..." : "Load more events"}
          </Button>
        ) : null}
      </section>

      <details className="job-detail__technical">
        <summary>Technical details</summary>
        <dl>
          <div>
            <dt>Automation ID</dt>
            <dd>{job.jobId}</dd>
          </div>
          <div>
            <dt>Owner lock hash</dt>
            <dd>{job.ownerLockHash}</dd>
          </div>
          <div>
            <dt>Cancellation lock hash</dt>
            <dd>{job.cancellationLockHash}</dd>
          </div>
          <div>
            <dt>Policy script hash</dt>
            <dd>{job.policyScriptHash}</dd>
          </div>
          <div>
            <dt>Payload hash</dt>
            <dd>{job.payloadHash}</dd>
          </div>
          <div>
            <dt>Trigger parameters hash</dt>
            <dd>{job.trigger.paramsHash}</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>
              v{job.protocol.version}, flags {job.protocol.flags}
            </dd>
          </div>
          <div>
            <dt>Raw JobData</dt>
            <dd>{job.protocol.rawData}</dd>
          </div>
          <div>
            <dt>Source confirmation hash</dt>
            <dd>{job.source.block.hash}</dd>
          </div>
          <div>
            <dt>Source transaction</dt>
            <dd>
              {job.source.outPoint.txHash}:{job.source.outPoint.index}
            </dd>
          </div>
        </dl>
      </details>
    </article>
  );
}
