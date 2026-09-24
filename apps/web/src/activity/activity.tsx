"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createApiClient, type ApiActivity, type ApiQuery } from "@ckb-automata/api-client";

import { parseWebEnvironment } from "../environment.ts";
import { requestErrorMessage } from "../request-errors.ts";
import { mergeActivity, type ActivityOutcomeFilter } from "./activity-model.ts";
import {
  ActivityView,
  type ActivityLoadState,
  type ActivitySourceFilter,
} from "./activity-view.tsx";

const PAGE_SIZE = 30;

function browserApiClient() {
  const environment = parseWebEnvironment({
    NEXT_PUBLIC_AUTOMATA_API_URL: process.env["NEXT_PUBLIC_AUTOMATA_API_URL"],
    NEXT_PUBLIC_CKB_NETWORK: process.env["NEXT_PUBLIC_CKB_NETWORK"],
  });
  return createApiClient({ baseUrl: environment.apiUrl });
}

export function ActivityFeed() {
  const apiResult = useMemo(() => {
    try {
      return { api: browserApiClient(), error: undefined } as const;
    } catch {
      return { api: undefined, error: "The public testnet API is not configured." } as const;
    }
  }, []);
  const [sourceFilter, setSourceFilter] = useState<ActivitySourceFilter>("");
  const [outcomeFilter, setOutcomeFilter] = useState<ActivityOutcomeFilter>("");
  const [items, setItems] = useState<ApiActivity["items"]>([]);
  const [checkpointBlock, setCheckpointBlock] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<ActivityLoadState>("loading");
  const [loadingNextPage, setLoadingNextPage] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  const query = useMemo<ApiQuery<"ActivityController_list">>(
    () => ({
      limit: PAGE_SIZE,
      ...(sourceFilter === "" ? {} : { source: sourceFilter }),
    }),
    [sourceFilter],
  );

  useEffect(() => {
    if (apiResult.api === undefined) {
      setError(apiResult.error);
      setLoadState("error");
      return;
    }
    let active = true;
    setItems([]);
    setError(undefined);
    setLoadState("loading");
    void apiResult.api
      .listActivity(query)
      .then((response) => {
        if (!active) return;
        setItems(response.items);
        setCheckpointBlock(response.indexCheckpoint?.blockNumber);
        setNextCursor(response.page.nextCursor);
        setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(requestErrorMessage("activity", reason));
        setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [apiResult, query, refreshKey]);

  const loadNextPage = useCallback(() => {
    if (apiResult.api === undefined || nextCursor === null || loadingNextPage) return;
    setLoadingNextPage(true);
    void apiResult.api
      .listActivity({ ...query, cursor: nextCursor })
      .then((response) => {
        setItems((current) => mergeActivity(current, response.items));
        setNextCursor(response.page.nextCursor);
      })
      .catch((reason: unknown) => setError(requestErrorMessage("activity", reason)))
      .finally(() => setLoadingNextPage(false));
  }, [apiResult.api, loadingNextPage, nextCursor, query]);

  return (
    <ActivityView
      {...(checkpointBlock === undefined ? {} : { checkpointBlock })}
      {...(error === undefined ? {} : { error })}
      hasNextPage={nextCursor !== null}
      items={items}
      loadState={loadState}
      loadingNextPage={loadingNextPage}
      onLoadNext={loadNextPage}
      onOutcomeChange={setOutcomeFilter}
      onRetry={() => setRefreshKey((current) => current + 1)}
      onSourceChange={setSourceFilter}
      outcomeFilter={outcomeFilter}
      sourceFilter={sourceFilter}
    />
  );
}
