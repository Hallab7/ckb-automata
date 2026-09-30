"use client";

import { CheckCircle2, Landmark, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  createApiClient,
  type ApiDaoHarvest,
  type ApiDaoHarvestBuild,
  type AutomataApiClient,
} from "@ckb-automata/api-client";
import { Button, Dialog, InlineNotice } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { ckbTestnetTransactionUrl, shortenCkbAddress } from "../ccc/wallet-display.ts";
import { browserWebEnvironment } from "../environment.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import { verifyCompletedDaoHarvestOwnerAction } from "../setup/dao-harvest-review.ts";
import { daoHarvestPresentation, formatHarvestPrincipal } from "./presentation.ts";

type OwnerOperation = "exit" | "recover" | "stop";

interface PreparedAction {
  readonly build: ApiDaoHarvestBuild;
  readonly snapshot: { readonly blockHash: string; readonly blockNumber: string };
  readonly transaction: ApiDaoHarvestBuild["transaction"];
  readonly transactionHash: string;
}

function actionCopy(operation: OwnerOperation) {
  if (operation === "stop")
    return {
      title: "Stop future harvests",
      description: "Stops recurrence and returns the unused service budget to your wallet.",
      button: "Prepare stop",
    };
  if (operation === "exit")
    return {
      title: "Exit DAO automation",
      description:
        "Starts the owner exit path. DAO maturity rules still apply before funds can become spendable.",
      button: "Prepare exit",
    };
  return {
    title: "Recover automation",
    description: "Builds the available owner recovery path without relying on an executor.",
    button: "Prepare recovery",
  };
}

async function buildAction(
  api: AutomataApiClient,
  operation: OwnerOperation,
  body: Record<string, unknown>,
) {
  if (operation === "stop") return api.stopDaoHarvest(body);
  if (operation === "exit") return api.exitDaoHarvest(body);
  return api.recoverDaoHarvest(body);
}

function HarvestOwnerAction({
  api,
  job,
  operation,
}: Readonly<{ api: AutomataApiClient; job: ApiDaoHarvest; operation: OwnerOperation }>) {
  const session = useWalletSession();
  const copy = actionCopy(operation);
  const [state, setState] = useState<
    | { readonly status: "idle" | "loading" | "submitting" }
    | { readonly status: "error"; readonly message: string }
    | { readonly status: "ready"; readonly value: PreparedAction }
    | { readonly status: "submitted"; readonly hash: string }
  >({ status: "idle" });

  const prepare = async () => {
    setState({ status: "loading" });
    try {
      if (session.ownerLockHash !== job.ownerLockHash)
        throw new Error("Reconnect the owner wallet.");
      const [build, network] = await Promise.all([
        buildAction(api, operation, { jobId: job.jobId, ownerLockHash: job.ownerLockHash }),
        api.network() as Promise<{
          readonly tip: { readonly blockHash: string; readonly blockNumber: string };
        }>,
      ]);
      if (build.operation !== operation || !/^0x[0-9a-f]{64}$/.test(build.policyCriticalHash)) {
        throw new Error("The owner action did not match this request.");
      }
      const completed = await session.completeForReview(build.transaction);
      verifyCompletedDaoHarvestOwnerAction(build.transaction, completed.transaction);
      setState({
        status: "ready",
        value: {
          build,
          snapshot: network.tip,
          transaction: completed.transaction,
          transactionHash: completed.hash,
        },
      });
    } catch {
      setState({
        status: "error",
        message: "This action could not be prepared. Please try again.",
      });
    }
  };

  const submit = async (prepared: PreparedAction) => {
    setState({ status: "submitting" });
    try {
      const refreshed = await buildAction(api, operation, {
        jobId: job.jobId,
        ownerLockHash: job.ownerLockHash,
      });
      if (
        refreshed.policyCriticalHash !== prepared.build.policyCriticalHash ||
        JSON.stringify(refreshed.transaction) !== JSON.stringify(prepared.build.transaction)
      ) {
        throw new Error("The action changed");
      }
      const signed = await session.signReviewedTransaction(
        prepared.transaction,
        prepared.transactionHash,
        prepared.snapshot,
      );
      const hash = await session.submitSignedTransaction(signed, prepared.transactionHash);
      setState({ status: "submitted", hash });
    } catch {
      setState({
        status: "error",
        message: "Nothing was submitted. Prepare a fresh review and try again.",
      });
    }
  };

  return (
    <Dialog
      description={copy.description}
      title={copy.title}
      trigger={
        <Button tone={operation === "recover" ? "primary" : "secondary"}>{copy.title}</Button>
      }
    >
      <div className="harvest-action-dialog">
        {state.status === "idle" ? (
          <>
            <p>
              CKAutomata will build the exact transaction first. Your wallet opens only after you
              review it.
            </p>
            <Button onClick={() => void prepare()}>{copy.button}</Button>
          </>
        ) : null}
        {state.status === "loading" ? (
          <div className="harvest-action-dialog__loading">
            <LoaderCircle className="setup-review-loading__icon" size={18} />
            <p>Checking the current chain state...</p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <InlineNotice title="Action unavailable" tone="danger">
            <p>{state.message}</p>
            <Button onClick={() => void prepare()} tone="secondary">
              Try again
            </Button>
          </InlineNotice>
        ) : null}
        {state.status === "ready" ? (
          <>
            <InlineNotice title="Transaction checked" tone="success">
              <p>The action and owner policy match this automation.</p>
            </InlineNotice>
            <dl>
              <div>
                <dt>Action</dt>
                <dd>{copy.title}</dd>
              </div>
              <div>
                <dt>Transaction</dt>
                <dd>
                  <code>{state.value.transactionHash}</code>
                </dd>
              </div>
            </dl>
            <Button icon={<ShieldCheck size={17} />} onClick={() => void submit(state.value)}>
              Approve in wallet
            </Button>
          </>
        ) : null}
        {state.status === "submitting" ? (
          <div className="harvest-action-dialog__loading">
            <LoaderCircle className="setup-review-loading__icon" size={18} />
            <p>Waiting for your wallet...</p>
          </div>
        ) : null}
        {state.status === "submitted" ? (
          <InlineNotice title="Submitted" tone="success">
            <p>The owner action is confirming on CKB testnet.</p>
            <a href={ckbTestnetTransactionUrl(state.hash)} rel="noreferrer" target="_blank">
              Open transaction
            </a>
          </InlineNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

export function DaoHarvestDetail({ jobId }: Readonly<{ jobId: string }>) {
  const session = useWalletSession();
  const client = useMemo(() => {
    try {
      return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
    } catch {
      return undefined;
    }
  }, []);
  const [job, setJob] = useState<ApiDaoHarvest>();
  const [state, setState] = useState<"error" | "loading" | "not_found" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const [title, setTitle] = useState("Harvest compensation");

  useEffect(
    () => setTitle(readAutomationTitles(window.localStorage)[jobId] ?? "Harvest compensation"),
    [jobId],
  );
  useEffect(() => {
    if (client === undefined) {
      setState("error");
      return;
    }
    let active = true;
    setState("loading");
    void client
      .getDaoHarvest(jobId)
      .then((value) => {
        if (!active) return;
        setJob(value);
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setState(
          typeof reason === "object" &&
            reason !== null &&
            "status" in reason &&
            reason.status === 404
            ? "not_found"
            : "error",
        );
      });
    return () => {
      active = false;
    };
  }, [client, jobId, retry]);

  if (state === "loading")
    return (
      <section className="app-page harvest-detail">
        <div className="harvest-detail__skeleton" aria-label="Loading harvest automation">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  if (state === "not_found")
    return (
      <section className="app-page">
        <InlineNotice title="Automation not found" tone="warning">
          <p>This DAO compensation automation is not indexed on CKB testnet.</p>
          <Link href="/automations">Return to automations</Link>
        </InlineNotice>
      </section>
    );
  if (state === "error" || job === undefined || client === undefined)
    return (
      <section className="app-page">
        <InlineNotice title="Something went wrong" tone="danger">
          <p>Please try again.</p>
          <Button
            icon={<RefreshCw size={16} />}
            onClick={() => setRetry((value) => value + 1)}
            tone="secondary"
          >
            Try again
          </Button>
        </InlineNotice>
      </section>
    );

  const presentation = daoHarvestPresentation(job);
  const owner = session.status === "ready" && session.ownerLockHash === job.ownerLockHash;
  return (
    <article className="app-page harvest-detail" aria-labelledby="harvest-detail-title">
      <header className="app-page-header harvest-detail__header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">DAO compensation</p>
          <h1 id="harvest-detail-title">{title}</h1>
          <p>{presentation.action}</p>
        </div>
        <span
          className={`ui-status ui-status--${presentation.status === "recovery" ? "danger" : presentation.status === "completed" ? "neutral" : "info"}`}
        >
          {presentation.statusLabel}
        </span>
      </header>
      <section className="harvest-detail__summary" aria-label="Harvest summary">
        <div>
          <span className="harvest-dashboard__icon">
            <Landmark size={18} />
          </span>
          <div>
            <small>Original amount</small>
            <strong>{formatHarvestPrincipal(job.principal)}</strong>
          </div>
        </div>
        <div>
          <small>Progress</small>
          <strong>
            {presentation.completedCycles} of {presentation.totalCycles} harvests
          </strong>
        </div>
        <div>
          <small>Compensation address</small>
          <strong
            title={job.payoutLockHash}
          >{`${job.payoutLockHash.slice(0, 10)}...${job.payoutLockHash.slice(-8)}`}</strong>
        </div>
      </section>
      <section className="harvest-detail__section">
        <h2>Progress</h2>
        <ol className="harvest-timeline">
          <li data-complete="true">
            <CheckCircle2 size={17} />
            <div>
              <strong>Original amount deposited</strong>
              <span>The protected amount entered the DAO automation.</span>
            </div>
          </li>
          {Array.from({ length: presentation.completedCycles }, (_, index) => (
            <li data-complete="true" key={index}>
              <CheckCircle2 size={17} />
              <div>
                <strong>Harvest {index + 1} completed</strong>
                <span>Compensation was paid and the original amount was re-deposited.</span>
              </div>
            </li>
          ))}
          {presentation.status !== "completed" ? (
            <li data-current="true">
              <LoaderCircle size={17} />
              <div>
                <strong>{presentation.action}</strong>
                <span>CKAutomata follows live DAO maturity and testnet confirmation rules.</span>
              </div>
            </li>
          ) : null}
        </ol>
      </section>
      <section className="harvest-detail__section">
        <h2>Compensation history</h2>
        {presentation.completedCycles === 0 ? (
          <p>No compensation payouts have completed yet.</p>
        ) : (
          <ul className="harvest-history">
            {Array.from({ length: presentation.completedCycles }, (_, index) => (
              <li key={index}>
                <span>Harvest {index + 1}</span>
                <strong>Paid to compensation address</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
      {owner && job.state !== "completed" ? (
        <section className="harvest-detail__section">
          <div>
            <h2>Owner controls</h2>
            <p>Only the connected owner wallet can use these actions.</p>
          </div>
          <p className="harvest-detail__owner">
            Connected as {shortenCkbAddress(session.address ?? "")}
          </p>
          <div className="harvest-detail__actions">
            <HarvestOwnerAction api={client} job={job} operation="stop" />
            {job.state === "deposited" ? (
              <HarvestOwnerAction api={client} job={job} operation="exit" />
            ) : null}
            {job.state === "recovery_required" ||
            job.state === "withdrawing" ||
            job.state === "claim_ready" ? (
              <HarvestOwnerAction api={client} job={job} operation="recover" />
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="harvest-detail__section harvest-detail__technical">
        <details>
          <summary>Technical details</summary>
          <dl>
            <div>
              <dt>Automation ID</dt>
              <dd>
                <code>{job.jobId}</code>
              </dd>
            </div>
            <div>
              <dt>Owner lock</dt>
              <dd>
                <code>{job.ownerLockHash}</code>
              </dd>
            </div>
            <div>
              <dt>Last indexed</dt>
              <dd>{new Date(job.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </details>
      </section>
    </article>
  );
}
