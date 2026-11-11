"use client";

import { ExternalLink, Landmark, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiDaoHarvestV3,
  type ApiDaoHarvestV3Build,
  type AutomataApiClient,
} from "@ckb-automata/api-client";
import {
  NERVDAO_HARVEST_TESTNET_NOTICE,
  NERVDAO_HARVEST_TIMING_NOTICES,
  nervDaoOwnerAction,
  nervDaoPositionLabel,
  type NervDaoOwnerAction,
} from "@ckb-automata/nervdao-integration";
import { Button, Dialog, InlineNotice } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { ckbTestnetTransactionUrl } from "../ccc/wallet-display.ts";
import { browserWebEnvironment } from "../environment.ts";
import {
  daoHarvestV3ReviewSnapshot,
  normalizeDaoHarvestV3Build,
  verifyDaoHarvestV3SignerChain,
  verifyCompletedDaoHarvestV3Review,
  verifyRefreshedDaoHarvestV3Build,
} from "../setup/dao-harvest-v3-review.ts";
import { harvestV2Amount } from "./v2-presentation.ts";

type OwnerOperation = NervDaoOwnerAction;
interface PreparedAction {
  readonly build: ApiDaoHarvestV3Build;
  readonly body: Record<string, unknown>;
  readonly completed: ReturnType<typeof normalizeDaoHarvestV3Build>["transaction"];
  readonly snapshot: ReturnType<typeof daoHarvestV3ReviewSnapshot>;
  readonly transactionHash: string;
}

const COPY = Object.freeze({
  "owner-exit": {
    title: "Start withdrawal",
    description:
      "Ends this automation and creates a normal DAO withdrawal controlled by your wallet. The amount becomes spendable only after normal DAO maturity.",
  },
  "owner-recovery": {
    title: "Claim and stop",
    description:
      "Claims a mature DAO withdrawal to your wallet and ends the automation. No completion service charge is taken; only already completed preparation work may be paid from earned compensation.",
  },
  "owner-complete": {
    title: "Complete harvest",
    description:
      "Completes the mature withdrawal. If another cycle remains, it starts automatically; otherwise your original DAO deposit returns to normal wallet control. No completion service charge is taken.",
  },
} satisfies Record<OwnerOperation, { readonly title: string; readonly description: string }>);

function friendlyError(reason: unknown) {
  if (reason instanceof ApiClientError && reason.status === 409) {
    return "The chain changed. Build a fresh review.";
  }
  if (reason instanceof ApiClientError && reason.status === 400) {
    return "This action is not ready yet. Refresh the automation and try again.";
  }
  return "Something went wrong. Please try again.";
}

function V3OwnerAction({
  api,
  job,
  operation,
}: Readonly<{
  api: AutomataApiClient;
  job: ApiDaoHarvestV3;
  operation: OwnerOperation;
}>) {
  const session = useWalletSession();
  const copy = COPY[operation];
  const [state, setState] = useState<
    | { readonly status: "idle" | "loading" | "submitting" }
    | { readonly status: "error"; readonly message: string }
    | { readonly status: "ready"; readonly value: PreparedAction }
    | { readonly status: "submitted"; readonly transactionHash: string }
  >({ status: "idle" });

  const requestBody = async () => {
    if (session.ownerLockHash !== job.ownerLockHash) throw new Error("Reconnect the owner wallet.");
    const [ownerLock, identityOutPoint] = await Promise.all([
      session.getOwnerLock(job.ownerLockHash),
      session.selectDeadlinePledge(),
    ]);
    return Object.freeze({
      jobId: job.jobId,
      ownerLock,
      identityOutPoint,
      maximumNetworkFee: "100000",
      ...(operation === "owner-recovery" || operation === "owner-complete"
        ? { prepareAccumulatorOutPoint: job.cells.prepareAccumulator }
        : {}),
    });
  };

  const prepare = async () => {
    setState({ status: "loading" });
    try {
      const environment = browserWebEnvironment();
      const signerGenesis = await session.getSignerGenesisHash();
      if (signerGenesis !== environment.genesisHash) {
        throw new Error("The connected wallet is not using CKB testnet.");
      }
      const body = await requestBody();
      const [build, network] = await Promise.all([
        api.buildDaoHarvestV3(operation, body),
        api.network() as Promise<{
          readonly tip: { readonly blockHash: string; readonly blockNumber: string };
        }>,
      ]);
      verifyDaoHarvestV3SignerChain(
        build,
        await session.getSignerGenesisHash(),
        environment.genesisHash,
      );
      const normalized = normalizeDaoHarvestV3Build(build);
      const completed = await session.completeForReview(normalized.transaction);
      verifyDaoHarvestV3SignerChain(
        build,
        await session.getSignerGenesisHash(),
        environment.genesisHash,
      );
      await verifyCompletedDaoHarvestV3Review(build, completed.transaction, session);
      setState({
        status: "ready",
        value: {
          build,
          body,
          completed: completed.transaction,
          snapshot: daoHarvestV3ReviewSnapshot(network.tip, build.chain),
          transactionHash: completed.hash,
        },
      });
    } catch (reason) {
      setState({ status: "error", message: friendlyError(reason) });
    }
  };

  const submit = async (prepared: PreparedAction) => {
    setState({ status: "submitting" });
    try {
      const environment = browserWebEnvironment();
      verifyDaoHarvestV3SignerChain(
        prepared.build,
        await session.getSignerGenesisHash(),
        environment.genesisHash,
      );
      const refreshed = await api.buildDaoHarvestV3(operation, prepared.body);
      verifyRefreshedDaoHarvestV3Build(prepared.build, refreshed);
      const signed = await session.signReviewedTransaction(
        prepared.completed,
        prepared.transactionHash,
        prepared.snapshot,
      );
      verifyDaoHarvestV3SignerChain(
        prepared.build,
        await session.getSignerGenesisHash(),
        environment.genesisHash,
      );
      const transactionHash = await session.submitSignedTransaction(
        signed,
        prepared.transactionHash,
      );
      setState({ status: "submitted", transactionHash });
    } catch (reason) {
      setState({ status: "error", message: friendlyError(reason) });
    }
  };

  return (
    <Dialog
      description={copy.description}
      title={copy.title}
      trigger={<Button>{copy.title}</Button>}
    >
      <div className="harvest-action-dialog">
        {state.status === "idle" ? (
          <Button onClick={() => void prepare()}>Review action</Button>
        ) : null}
        {state.status === "loading" || state.status === "submitting" ? (
          <div aria-live="polite" className="harvest-action-dialog__loading">
            <LoaderCircle className="setup-review-loading__icon" size={18} />
            <p>
              {state.status === "loading"
                ? "Checking live chain data..."
                : "Waiting for your wallet..."}
            </p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <InlineNotice title="Action unavailable" tone="danger">
            <p>{state.message}</p>
            <Button onClick={() => setState({ status: "idle" })} tone="secondary">
              Start again
            </Button>
          </InlineNotice>
        ) : null}
        {state.status === "ready" ? (
          <>
            <InlineNotice title="Transaction checked" tone="success">
              <p>
                The original amount, DAO output position, owner return, and maximum fee match this
                review.
              </p>
            </InlineNotice>
            <dl>
              <div>
                <dt>Original amount</dt>
                <dd>{harvestV2Amount(state.value.build.review.protectedAmount)}</dd>
              </div>
              <div>
                <dt>Maximum network fee</dt>
                <dd>{harvestV2Amount(state.value.build.review.maximumNetworkFee)}</dd>
              </div>
            </dl>
            <InlineNotice title={NERVDAO_HARVEST_TESTNET_NOTICE.title} tone="warning">
              <p>{NERVDAO_HARVEST_TESTNET_NOTICE.body}</p>
            </InlineNotice>
            <Button icon={<ShieldCheck size={17} />} onClick={() => void submit(state.value)}>
              Approve in wallet
            </Button>
          </>
        ) : null}
        {state.status === "submitted" ? (
          <InlineNotice title="Submitted" tone="success">
            <p>The transaction is confirming on CKB testnet.</p>
            <a
              href={ckbTestnetTransactionUrl(state.transactionHash)}
              rel="noreferrer"
              target="_blank"
            >
              Open transaction <ExternalLink size={14} />
            </a>
          </InlineNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

function status(job: ApiDaoHarvestV3) {
  return nervDaoPositionLabel(job.state);
}

export function DaoHarvestV3Detail({ jobId }: Readonly<{ jobId: string }>) {
  const session = useWalletSession();
  const api = useMemo(() => {
    try {
      return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
    } catch {
      return undefined;
    }
  }, []);
  const [job, setJob] = useState<ApiDaoHarvestV3>();
  const [loadState, setLoadState] = useState<"error" | "loading" | "not_found" | "ready">(
    "loading",
  );
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!api) {
      setLoadState("error");
      return;
    }
    let active = true;
    setLoadState("loading");
    void api
      .getDaoHarvestV3(jobId)
      .then((value) => {
        if (active) {
          setJob(value);
          setLoadState("ready");
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setLoadState(
            reason instanceof ApiClientError && reason.status === 404 ? "not_found" : "error",
          );
      });
    return () => {
      active = false;
    };
  }, [api, jobId, retry]);

  if (loadState === "loading")
    return (
      <section
        aria-busy="true"
        aria-label="Loading harvest automation"
        className="app-page harvest-detail"
      >
        <div className="harvest-detail__skeleton">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  if (loadState === "not_found")
    return (
      <section className="app-page">
        <InlineNotice title="Automation not found" tone="warning">
          <p>This V3 harvest automation is not available on CKB testnet.</p>
          <Link href="/automations">Return to automations</Link>
        </InlineNotice>
      </section>
    );
  if (loadState === "error" || !job || !api)
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

  const owner = session.status === "ready" && session.ownerLockHash === job.ownerLockHash;
  const operation = nervDaoOwnerAction(job.state, job.cells.prepareAccumulator !== null);
  const operations: readonly OwnerOperation[] =
    operation === "owner-recovery"
      ? ["owner-complete", "owner-recovery"]
      : operation
        ? [operation]
        : [];
  return (
    <article aria-labelledby="harvest-v3-title" className="app-page harvest-detail">
      <header className="app-page-header harvest-detail__header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">DAO harvest</p>
          <h1 id="harvest-v3-title">Harvest compensation</h1>
          <p>Canonical V3 position on CKB testnet</p>
        </div>
        <span className="ui-status ui-status--info">{status(job)}</span>
      </header>
      <section aria-label="Harvest summary" className="harvest-detail__summary">
        <div>
          <span className="harvest-dashboard__icon">
            <Landmark size={18} />
          </span>
          <div>
            <small>Original amount</small>
            <strong>{harvestV2Amount(job.principalCapacity)}</strong>
          </div>
        </div>
        <div>
          <small>Progress</small>
          <strong>
            {job.progress.cycle} of {job.progress.totalCycles} harvests
          </strong>
        </div>
        <div>
          <small>Chain evidence</small>
          <strong>
            <a
              href={ckbTestnetTransactionUrl(job.evidence.transactionHash)}
              rel="noreferrer"
              target="_blank"
            >
              View transaction <ExternalLink size={14} />
            </a>
          </strong>
        </div>
      </section>
      <section className="harvest-detail__section">
        <h2>Timing and control</h2>
        <ul>
          {NERVDAO_HARVEST_TIMING_NOTICES.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
        <InlineNotice title={NERVDAO_HARVEST_TESTNET_NOTICE.title} tone="warning">
          <p>{NERVDAO_HARVEST_TESTNET_NOTICE.body}</p>
        </InlineNotice>
      </section>
      {job.state === "owner_withdrawing" ? (
        <InlineNotice title="Wait for DAO maturity" tone="warning">
          <p>
            The automation has ended. Your withdrawal is controlled by your wallet and can be
            claimed with a normal DAO withdrawal after it matures.
          </p>
        </InlineNotice>
      ) : null}
      <section className="harvest-detail__section">
        <h2>Owner actions</h2>
        {!owner ? (
          <p>Connect the owner wallet to review available actions.</p>
        ) : operations.length > 0 ? (
          <div className="harvest-detail__actions">
            {operations.map((ownerOperation) => (
              <V3OwnerAction api={api} job={job} key={ownerOperation} operation={ownerOperation} />
            ))}
          </div>
        ) : (
          <p>No owner action is currently available.</p>
        )}
      </section>
    </article>
  );
}
