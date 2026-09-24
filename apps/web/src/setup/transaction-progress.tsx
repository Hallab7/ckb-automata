"use client";

import {
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDot,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { createApiClient, type ApiTransactionProgress } from "@ckb-automata/api-client";
import { InlineNotice } from "@ckb-automata/ui";

import { ckbTestnetTransactionUrl } from "../ccc/wallet-display.ts";
import { browserWebEnvironment } from "../environment.ts";
import { reduceTransactionProgress, reduceTransactionProgressStream } from "../stream-reducers.ts";
import {
  initialTransactionProgress,
  parseTransactionProgress,
  progressQuery,
  readTransactionProgress,
  sameTransactionProgress,
  transactionProgressPresentation,
  writeTransactionProgress,
  type TransactionProgressState,
} from "./transaction-progress-model.ts";

const POLL_INTERVAL_MS = 3_000;
const orderedStates: readonly TransactionProgressState[] = [
  "submitted",
  "proposed",
  "committed",
  "confirmed",
];

export interface TransactionTrackingRecord {
  readonly persistedAt: string;
  readonly transactionHash: string;
}

function streamUrl(record: TransactionTrackingRecord, previous: ApiTransactionProgress): string {
  const url = new URL(
    `v1/transactions/${encodeURIComponent(record.transactionHash)}/progress/stream`,
    browserWebEnvironment().sseUrl,
  );
  const query = progressQuery(record.persistedAt, previous);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

function stateIcon(state: TransactionProgressState): ReactNode {
  if (state === "confirmed") return <CheckCircle2 aria-hidden="true" size={24} />;
  if (state === "dropped") return <CircleAlert aria-hidden="true" size={24} />;
  if (state === "conflicted") return <ShieldAlert aria-hidden="true" size={24} />;
  if (state === "reorged") return <RotateCcw aria-hidden="true" size={24} />;
  if (state === "submitted") return <Send aria-hidden="true" size={24} />;
  if (state === "proposed") return <CircleDot aria-hidden="true" size={24} />;
  return <RefreshCw aria-hidden="true" size={24} />;
}

export function TransactionProgressPanel({
  persisted,
  progress,
  transportIssue,
}: Readonly<{
  persisted: boolean;
  progress: ApiTransactionProgress;
  transportIssue?: string;
}>) {
  const activeIndex = orderedStates.indexOf(progress.state);
  const status = transactionProgressPresentation(progress.state);
  return (
    <section
      aria-live="polite"
      className={`transaction-progress transaction-progress--${status.tone}`}
      data-progress-state={progress.state}
    >
      <div className="transaction-progress__heading">
        <span className="transaction-progress__state-icon">{stateIcon(progress.state)}</span>
        <div>
          <p className="transaction-progress__eyebrow">Transaction progress</p>
          <h2>{status.title}</h2>
          <p>{progress.reason ?? status.detail}</p>
        </div>
      </div>

      <ol className="transaction-progress__steps" aria-label="Transaction confirmation stages">
        {orderedStates.map((state, index) => {
          const complete = activeIndex >= 0 && index < activeIndex;
          const active = state === progress.state;
          return (
            <li
              aria-current={active ? "step" : undefined}
              className={active ? "is-active" : complete ? "is-complete" : undefined}
              key={state}
            >
              <span>
                {complete ? (
                  <Check aria-hidden="true" size={14} />
                ) : (
                  <Circle aria-hidden="true" size={14} />
                )}
              </span>
              {transactionProgressPresentation(state).title}
            </li>
          );
        })}
      </ol>

      <dl className="transaction-progress__facts">
        <div>
          <dt>Confirmations</dt>
          <dd>
            {progress.confirmations} / {progress.requiredConfirmations}
          </dd>
        </div>
        <div>
          <dt>Block</dt>
          <dd>{progress.block?.number ?? "Waiting"}</dd>
        </div>
      </dl>

      <div className="transaction-progress__hash">
        <code>{progress.transactionHash}</code>
        <a
          href={ckbTestnetTransactionUrl(progress.transactionHash)}
          rel="noreferrer"
          target="_blank"
        >
          Open in explorer <ExternalLink aria-hidden="true" size={15} />
        </a>
      </div>

      {persisted ? null : (
        <InlineNotice title="Local recovery unavailable" tone="warning">
          <p>Keep this transaction hash. Browser storage could not retain it.</p>
        </InlineNotice>
      )}
      {transportIssue === undefined ? null : (
        <p className="transaction-progress__transport">{transportIssue}</p>
      )}
    </section>
  );
}

export function TransactionProgressTracker({
  persisted = true,
  record,
}: Readonly<{ persisted?: boolean; record: TransactionTrackingRecord }>) {
  const [progress, setProgress] = useState<ApiTransactionProgress>(() =>
    initialTransactionProgress(record.transactionHash, record.persistedAt),
  );
  const [transportIssue, setTransportIssue] = useState<string>();

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const environment = browserWebEnvironment();
    const api = createApiClient({ baseUrl: environment.apiUrl });
    const restored = readTransactionProgress(window.localStorage, record.transactionHash);
    const baseline = restored ?? progress;
    if (restored !== undefined && !sameTransactionProgress(progress, restored)) {
      setProgress(restored);
    }
    const query = progressQuery(record.persistedAt, baseline);
    const apply = (value: unknown) => {
      if (stopped) return;
      const next = parseTransactionProgress(value);
      if (next === undefined || next.transactionHash !== record.transactionHash) return;
      writeTransactionProgress(window.localStorage, next);
      setProgress(
        (current) => reduceTransactionProgress(current, next, record.transactionHash).value,
      );
      setTransportIssue(undefined);
    };
    const poll = async () => {
      try {
        apply(await api.getTransactionProgress(record.transactionHash, query));
      } catch {
        if (!stopped) {
          setTransportIssue(
            "Live updates are temporarily unavailable. The last verified state is retained.",
          );
        }
      }
    };
    const startPolling = () => {
      if (pollTimer !== undefined || stopped) return;
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    if (typeof EventSource === "undefined") {
      startPolling();
      return () => {
        stopped = true;
        if (pollTimer !== undefined) clearInterval(pollTimer);
      };
    }

    const source = new EventSource(streamUrl(record, baseline));
    source.addEventListener("transaction-progress", (event) => {
      const reduction = reduceTransactionProgressStream(
        progress,
        (event as MessageEvent<string>).data,
        record.transactionHash,
      );
      if (reduction.kind === "invalid") {
        setTransportIssue(
          "A live update was invalid. Polling will verify the current chain state.",
        );
        source.close();
        startPolling();
        return;
      }
      if (reduction.kind === "accepted") apply(reduction.value);
    });
    source.addEventListener("error", () => {
      source.close();
      startPolling();
    });

    return () => {
      stopped = true;
      source.close();
      if (pollTimer !== undefined) clearInterval(pollTimer);
    };
  }, [progress.block?.hash, progress.block?.number, record]);

  return (
    <TransactionProgressPanel
      persisted={persisted}
      progress={progress}
      {...(transportIssue === undefined ? {} : { transportIssue })}
    />
  );
}
