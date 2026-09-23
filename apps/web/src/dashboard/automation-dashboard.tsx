"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiJobList,
  type ApiQuery,
  type AutomataApiClient,
} from "@ckb-automata/api-client";

import { useWalletSession } from "../ccc/session.tsx";
import { parseWebEnvironment } from "../environment.ts";
import {
  AutomationDashboardView,
  type DashboardLoadState,
  type DashboardMode,
} from "./dashboard-view.tsx";

function browserApiClient(): AutomataApiClient {
  const environment = parseWebEnvironment({
    NEXT_PUBLIC_AUTOMATA_API_URL: process.env["NEXT_PUBLIC_AUTOMATA_API_URL"],
    NEXT_PUBLIC_CKB_NETWORK: process.env["NEXT_PUBLIC_CKB_NETWORK"],
  });
  return createApiClient({ baseUrl: environment.apiUrl });
}

function requestError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 409)
      return "The index advanced during pagination. Refresh the list to continue.";
    if (error.status >= 500) return "The testnet job index is temporarily unavailable.";
    return "The API rejected this automation query.";
  }
  return error instanceof TypeError
    ? "The testnet API could not be reached. Check the API connection and retry."
    : "The automation list could not be loaded.";
}

export function AutomationDashboard() {
  const session = useWalletSession();
  const apiResult = useMemo(() => {
    try {
      return { api: browserApiClient(), error: undefined } as const;
    } catch {
      return { api: undefined, error: "The public testnet API is not configured." } as const;
    }
  }, []);
  const [mode, setMode] = useState<DashboardMode>("public");
  const [stateFilter, setStateFilter] = useState("");
  const [templateFilter, setTemplateFilter] = useState("");
  const [items, setItems] = useState<ApiJobList["items"]>([]);
  const [checkpointBlock, setCheckpointBlock] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<DashboardLoadState>("loading");
  const [error, setError] = useState<string>();
  const [loadingNextPage, setLoadingNextPage] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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
      setLoadState("error");
      return;
    }
    if (mode === "owner") {
      if (session.status !== "ready") {
        setItems([]);
        setLoadState("owner_required");
        return;
      }
      if (session.detailsStatus === "loading") {
        setItems([]);
        setLoadState("loading");
        return;
      }
      if (session.ownerLockHash === undefined) {
        setError("The connected wallet lock could not be resolved. Retry the wallet details.");
        setItems([]);
        setLoadState("error");
        return;
      }
    }

    let active = true;
    setError(undefined);
    setItems([]);
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
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(requestError(reason));
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
      })
      .catch((reason: unknown) => {
        setError(requestError(reason));
        setLoadState("error");
      })
      .finally(() => setLoadingNextPage(false));
  }, [apiResult, loadingNextPage, mode, nextCursor, query, session.ownerLockHash]);

  return (
    <AutomationDashboardView
      checkpointBlock={checkpointBlock}
      error={error}
      hasNextPage={nextCursor !== null}
      items={items}
      loadState={loadState}
      loadingNextPage={loadingNextPage}
      mode={mode}
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
    />
  );
}
