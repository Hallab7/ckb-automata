"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createApiClient,
  type ApiJobList,
  type ApiQuery,
  type AutomataApiClient,
} from "@ckb-automata/api-client";

import { useWalletSession } from "../ccc/session.tsx";
import { createLiveDataProvider, LIVE_DATA_LABEL } from "../data-provider.ts";
import { browserWebEnvironment } from "../environment.ts";
import { requestErrorMessage } from "../request-errors.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import {
  AutomationDashboardView,
  type DashboardLoadState,
  type DashboardMode,
} from "./dashboard-view.tsx";
import type { DashboardJob, RecipientAmountsByJob } from "./dashboard-model.ts";

function browserApiClient(): AutomataApiClient {
  const environment = browserWebEnvironment();
  return createApiClient({ baseUrl: environment.apiUrl });
}

async function loadRecipientAmounts(
  api: AutomataApiClient,
  jobs: readonly DashboardJob[],
): Promise<RecipientAmountsByJob> {
  const entries = await Promise.all(
    jobs.map(async (job) => {
      try {
        const terms = await api.getJobTerms(job.jobId);
        return [job.jobId, terms.payout] as const;
      } catch {
        return [job.jobId, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function AutomationDashboard() {
  const session = useWalletSession();
  const apiResult = useMemo(() => {
    try {
      const provider = createLiveDataProvider(browserApiClient);
      return { api: provider.load(), error: undefined } as const;
    } catch {
      return { api: undefined, error: "The public testnet API is not configured." } as const;
    }
  }, []);
  const [mode, setMode] = useState<DashboardMode>("public");
  const [stateFilter, setStateFilter] = useState("");
  const [templateFilter, setTemplateFilter] = useState("");
  const [items, setItems] = useState<ApiJobList["items"]>([]);
  const [recipientAmounts, setRecipientAmounts] = useState<RecipientAmountsByJob>({});
  const [checkpointBlock, setCheckpointBlock] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<DashboardLoadState>("loading");
  const [error, setError] = useState<string>();
  const [loadingNextPage, setLoadingNextPage] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => setTitles(readAutomationTitles(window.localStorage)), [items]);

  const query = useMemo<ApiQuery<"JobsController_list">>(
    () => ({
      limit: 12,
      ...(stateFilter
        ? { state: stateFilter as NonNullable<ApiQuery<"JobsController_list">["state"]> }
        : {}),
      ...(templateFilter
        ? { template: templateFilter as NonNullable<ApiQuery<"JobsController_list">["template"]> }
        : {}),
    }),
    [stateFilter, templateFilter],
  );

  useEffect(() => {
    if (apiResult.api === undefined) {
      setError(apiResult.error);
      setItems([]);
      setRecipientAmounts({});
      setLoadState("error");
      return;
    }
    if (mode === "owner") {
      if (session.status !== "ready") {
        setItems([]);
        setRecipientAmounts({});
        setLoadState("owner_required");
        return;
      }
      if (session.detailsStatus === "loading") {
        setItems([]);
        setRecipientAmounts({});
        setLoadState("loading");
        return;
      }
      if (session.ownerLockHash === undefined) {
        setError("The connected wallet lock could not be resolved. Retry the wallet details.");
        setItems([]);
        setRecipientAmounts({});
        setLoadState("error");
        return;
      }
    }

    let active = true;
    setError(undefined);
    setItems([]);
    setRecipientAmounts({});
    setCheckpointBlock(undefined);
    setNextCursor(null);
    setLoadState("loading");
    const request =
      mode === "owner"
        ? apiResult.api.listAccountJobs(session.ownerLockHash!, query)
        : apiResult.api.listJobs(query);
    void request
      .then((response) => {
        if (!active) return;
        setItems(response.items);
        setCheckpointBlock(response.indexCheckpoint?.blockNumber);
        setNextCursor(response.page.nextCursor);
        setLoadState("ready");
        void loadRecipientAmounts(apiResult.api!, response.items).then((amounts) => {
          if (active) setRecipientAmounts(amounts);
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(requestErrorMessage("dashboard", reason));
        setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [
    apiResult,
    mode,
    query,
    refreshKey,
    session.detailsStatus,
    session.ownerLockHash,
    session.status,
  ]);

  const loadNextPage = useCallback(() => {
    if (apiResult.api === undefined || nextCursor === null || loadingNextPage) return;
    if (mode === "owner" && session.ownerLockHash === undefined) return;
    setLoadingNextPage(true);
    const cursorQuery = { ...query, cursor: nextCursor };
    const request =
      mode === "owner"
        ? apiResult.api.listAccountJobs(session.ownerLockHash!, cursorQuery)
        : apiResult.api.listJobs(cursorQuery);
    void request
      .then((response) => {
        setItems((current) => [...current, ...response.items]);
        setCheckpointBlock(response.indexCheckpoint?.blockNumber);
        setNextCursor(response.page.nextCursor);
        void loadRecipientAmounts(apiResult.api!, response.items).then((amounts) => {
          setRecipientAmounts((current) => ({ ...current, ...amounts }));
        });
      })
      .catch((reason: unknown) => {
        setError(requestErrorMessage("dashboard", reason));
        setLoadState("error");
      })
      .finally(() => setLoadingNextPage(false));
  }, [apiResult, loadingNextPage, mode, nextCursor, query, session.ownerLockHash]);

  return (
    <AutomationDashboardView
      checkpointBlock={checkpointBlock}
      dataSourceLabel={LIVE_DATA_LABEL}
      error={error}
      hasNextPage={nextCursor !== null}
      items={items}
      loadState={loadState}
      loadingNextPage={loadingNextPage}
      mode={mode}
      recipientAmounts={recipientAmounts}
      onConnect={session.open}
      onLoadNext={loadNextPage}
      onModeChange={setMode}
      onRetry={() => {
        session.refreshDetails();
        setRefreshKey((current) => current + 1);
      }}
      onStateChange={setStateFilter}
      onTemplateChange={setTemplateFilter}
      stateFilter={stateFilter}
      templateFilter={templateFilter}
      titles={titles}
    />
  );
}
