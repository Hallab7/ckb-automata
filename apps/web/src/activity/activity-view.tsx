"use client";

import { ExternalLink, FileCheck2, History, RefreshCw } from "lucide-react";
import Link from "next/link";

import type { ApiActivity } from "@ckb-automata/api-client";
import { Button, InlineNotice, SelectField } from "@ckb-automata/ui";

import { ckbTestnetBlockUrl, ckbTestnetTransactionUrl } from "../ccc/wallet-display.ts";
import {
  activityLabel,
  activityOutcome,
  filterActivity,
  groupActivity,
  type ActivityEvent,
  type ActivityOutcomeFilter,
} from "./activity-model.ts";

export type ActivityLoadState = "error" | "loading" | "ready";
export type ActivitySourceFilter = "" | "indexed" | "operational";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function confidenceTone(confidence: ActivityEvent["confidence"]): string {
  if (confidence === "confirmed") return "success";
  if (confidence === "reorged") return "warning";
  if (confidence === "committed") return "info";
  return "neutral";
}

function ActivityItem({ event }: Readonly<{ event: ActivityEvent }>) {
  const transactionHash = event.block?.transactionHash ?? event.attempt?.transactionHash;
  return (
    <li className="activity-event" data-confidence={event.confidence} data-source={event.source}>
      <div className="activity-event__heading">
        <div>
          <h3>{activityLabel(event)}</h3>
          <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)} UTC</time>
        </div>
        <div className="activity-event__badges">
          <span
            className={`ui-status ui-status--${event.source === "indexed" ? "info" : "neutral"}`}
          >
            {event.source === "indexed" ? "Indexed chain event" : "Operational attempt"}
          </span>
          <span className={`ui-status ui-status--${confidenceTone(event.confidence)}`}>
            {event.confidence}
          </span>
        </div>
      </div>

      <dl className="activity-event__facts">
        <div>
          <dt>Outcome</dt>
          <dd>{activityOutcome(event).replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Block reference</dt>
          <dd>
            {event.block === null ? (
              "No canonical block"
            ) : (
              <a href={ckbTestnetBlockUrl(event.block.number)} rel="noreferrer" target="_blank">
                #{BigInt(event.block.number).toLocaleString("en-US")}
                <ExternalLink aria-hidden="true" size={13} />
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>Transaction</dt>
          <dd>
            {transactionHash === null || transactionHash === undefined ? (
              "Not submitted"
            ) : (
              <a href={ckbTestnetTransactionUrl(transactionHash)} rel="noreferrer" target="_blank">
                {shortHash(transactionHash)}
                <ExternalLink aria-hidden="true" size={13} />
              </a>
            )}
          </dd>
        </div>
      </dl>

      {event.attempt?.receipt === null || event.attempt?.receipt === undefined ? null : (
        <details className="activity-event__receipt">
          <summary>
            <FileCheck2 aria-hidden="true" size={15} /> Executor receipt
          </summary>
          <dl>
            <div>
              <dt>Receipt ID</dt>
              <dd>{event.attempt.receipt.id}</dd>
            </div>
            <div>
              <dt>Executor</dt>
              <dd>{event.attempt.receipt.executorLockHash}</dd>
            </div>
            <div>
              <dt>Key ID</dt>
              <dd>{event.attempt.receipt.keyId}</dd>
            </div>
          </dl>
        </details>
      )}
    </li>
  );
}

export interface ActivityViewProperties {
  readonly checkpointBlock?: string;
  readonly error?: string;
  readonly hasNextPage?: boolean;
  readonly items: ApiActivity["items"];
  readonly loadState: ActivityLoadState;
  readonly loadingNextPage?: boolean;
  readonly onLoadNext?: () => void;
  readonly onOutcomeChange: (outcome: ActivityOutcomeFilter) => void;
  readonly onRetry?: () => void;
  readonly onSourceChange: (source: ActivitySourceFilter) => void;
  readonly outcomeFilter: ActivityOutcomeFilter;
  readonly sourceFilter: ActivitySourceFilter;
}

export function ActivityView({
  checkpointBlock,
  error,
  hasNextPage = false,
  items,
  loadState,
  loadingNextPage = false,
  onLoadNext,
  onOutcomeChange,
  onRetry,
  onSourceChange,
  outcomeFilter,
  sourceFilter,
}: ActivityViewProperties) {
  const visible = filterActivity(items, outcomeFilter);
  const groups = groupActivity(visible);
  return (
    <section className="app-page activity-view" aria-labelledby="activity-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <h1 id="activity-title">Activity</h1>
          <p>
            {checkpointBlock === undefined
              ? "Transaction and execution evidence"
              : `Canonical through block #${BigInt(checkpointBlock).toLocaleString("en-US")}`}
          </p>
        </div>
      </header>

      <div className="activity-toolbar">
        <SelectField
          label="Evidence source"
          onChange={(event) => onSourceChange(event.target.value as ActivitySourceFilter)}
          value={sourceFilter}
        >
          <option value="">All evidence</option>
          <option value="indexed">Indexed chain events</option>
          <option value="operational">Operational attempts</option>
        </SelectField>
        <SelectField
          label="Outcome"
          onChange={(event) => onOutcomeChange(event.target.value as ActivityOutcomeFilter)}
          value={outcomeFilter}
        >
          <option value="">All outcomes</option>
          <option value="submitted">Submitted</option>
          <option value="confirmed">Confirmed</option>
          <option value="conflicted">Losing contention</option>
          <option value="dropped">Dropped</option>
          <option value="reorged">Reorged</option>
          <option value="cancelled">Cancelled</option>
          <option value="recovery">Recovery</option>
        </SelectField>
      </div>

      <InlineNotice title="Evidence remains separate" tone="info">
        <p>
          Operational attempts describe executor activity. Only indexed events with block references
          describe canonical chain results.
        </p>
      </InlineNotice>

      {loadState === "loading" ? (
        <div className="activity-loading" aria-live="polite">
          <RefreshCw aria-hidden="true" size={20} /> Loading activity...
        </div>
      ) : null}
      {loadState === "error" ? (
        <InlineNotice title="Activity unavailable" tone="danger">
          <p>{error ?? "The activity feed could not be loaded."}</p>
          <Button
            icon={<RefreshCw aria-hidden="true" size={16} />}
            onClick={onRetry}
            tone="secondary"
          >
            Retry
          </Button>
        </InlineNotice>
      ) : null}
      {loadState === "ready" && error !== undefined ? (
        <InlineNotice title="Older activity not loaded" tone="warning">
          <p>{error}</p>
          <Button
            icon={<RefreshCw aria-hidden="true" size={16} />}
            onClick={onRetry}
            tone="secondary"
          >
            Refresh feed
          </Button>
        </InlineNotice>
      ) : null}
      {loadState === "ready" && groups.length === 0 ? (
        <div className="app-empty-state">
          <History aria-hidden="true" size={22} />
          <h2>No matching activity</h2>
          <p>Change the evidence or outcome filter to inspect other events.</p>
        </div>
      ) : null}

      <div className="activity-groups">
        {groups.map((group) => (
          <section
            className="activity-group"
            key={group.jobId}
            aria-labelledby={`activity-${group.jobId}`}
          >
            <header>
              <div>
                <p>Automation</p>
                <h2 id={`activity-${group.jobId}`}>{shortHash(group.jobId)}</h2>
              </div>
              <Link href={`/automations/${encodeURIComponent(group.jobId)}`}>Open details</Link>
            </header>
            <ol>
              {group.items.map((event) => (
                <ActivityItem event={event} key={event.eventId} />
              ))}
            </ol>
          </section>
        ))}
      </div>

      {loadState === "ready" && hasNextPage ? (
        <Button disabled={loadingNextPage} onClick={onLoadNext} tone="secondary">
          {loadingNextPage ? "Loading..." : "Load older activity"}
        </Button>
      ) : null}
    </section>
  );
}
