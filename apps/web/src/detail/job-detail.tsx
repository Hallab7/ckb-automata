"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiJob,
  type ApiJobEvents,
  type AutomataApiClient,
} from "@ckb-automata/api-client";

import { parseWebEnvironment } from "../environment.ts";
import { JobDetailView, type JobDetailLoadState } from "./job-detail-view.tsx";
import { mergeTimeline, type DetailEvent } from "./job-detail-model.ts";
import { OwnerActions } from "./owner-actions.tsx";

const EVENT_PAGE_SIZE = 50;
const EVENT_POLL_MS = 5_000;

function browserEnvironment() {
  return parseWebEnvironment({
    NEXT_PUBLIC_AUTOMATA_API_URL: process.env["NEXT_PUBLIC_AUTOMATA_API_URL"],
    NEXT_PUBLIC_CKB_NETWORK: process.env["NEXT_PUBLIC_CKB_NETWORK"],
  });
}

function requestError(error: unknown): {
  readonly message: string;
  readonly state: JobDetailLoadState;
} {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return {
        message: "The automation was not found at the current checkpoint.",
        state: "not_found",
      };
    }
    if (error.status === 409) {
      return {
        message: "The index advanced while the timeline was loading. Refresh and retry.",
        state: "error",
      };
    }
    if (error.status >= 500) {
      return { message: "The testnet job index is temporarily unavailable.", state: "error" };
    }
  }
  return {
    message:
      error instanceof TypeError
        ? "The testnet API could not be reached. Check the API connection and retry."
        : "The automation detail could not be loaded.",
    state: "error",
  };
}

function streamUrl(baseUrl: string, jobId: string): string {
  const url = new URL("v1/events/stream", baseUrl);
  url.searchParams.set("jobId", jobId);
  return url.toString();
}

export function AutomationDetail({ jobId }: Readonly<{ jobId: string }>) {
  const apiResult = useMemo(() => {
    try {
      const environment = browserEnvironment();
      return {
        api: createApiClient({ baseUrl: environment.apiUrl }),
        apiUrl: environment.apiUrl,
        error: undefined,
      } as const;
    } catch {
      return {
        api: undefined,
        apiUrl: undefined,
        error: "The public testnet API is not configured.",
      } as const;
    }
  }, []);
  const [job, setJob] = useState<ApiJob>();
  const [events, setEvents] = useState<ApiJobEvents["items"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<JobDetailLoadState>("loading");
  const [loadingNextPage, setLoadingNextPage] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(
    async (api: AutomataApiClient) => {
      const [nextJob, timeline] = await Promise.all([
        api.getJob(jobId),
        api.listJobEvents(jobId, { limit: EVENT_PAGE_SIZE }),
      ]);
      setJob(nextJob);
      setEvents(timeline.items);
      setNextCursor(timeline.page.nextCursor);
    },
    [jobId],
  );

  useEffect(() => {
    if (apiResult.api === undefined) {
      setError(apiResult.error);
      setLoadState("error");
      return;
    }
    let active = true;
    setLoadState("loading");
    setError(undefined);
    void load(apiResult.api)
      .then(() => {
        if (active) setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const failure = requestError(reason);
        setError(failure.message);
        setLoadState(failure.state);
      });
    return () => {
      active = false;
    };
  }, [apiResult, load, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready" || apiResult.api === undefined || apiResult.apiUrl === undefined) {
      return;
    }
    let stopped = false;
    let polling: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      try {
        const [nextJob, timeline] = await Promise.all([
          apiResult.api!.getJob(jobId),
          apiResult.api!.listJobEvents(jobId, { limit: 100 }),
        ]);
        if (stopped) return;
        setJob(nextJob);
        setEvents((current) => mergeTimeline(current, timeline.items));
      } catch {
        // The existing verified state remains visible until the next successful read.
      }
    };
    const startPolling = () => {
      if (polling !== undefined || stopped) return;
      void refresh();
      polling = setInterval(() => void refresh(), EVENT_POLL_MS);
    };
    if (typeof EventSource === "undefined") {
      startPolling();
      return () => {
        stopped = true;
        if (polling !== undefined) clearInterval(polling);
      };
    }

    const source = new EventSource(streamUrl(apiResult.apiUrl, jobId));
    const receive = (event: Event) => {
      try {
        const item = JSON.parse((event as MessageEvent<string>).data) as DetailEvent;
        if (item.jobId !== jobId || stopped) return;
        setEvents((current) => mergeTimeline(current, [item]));
        void apiResult
          .api!.getJob(jobId)
          .then((nextJob) => {
            if (!stopped) setJob(nextJob);
          })
          .catch(() => {
            source.close();
            startPolling();
          });
      } catch {
        source.close();
        startPolling();
      }
    };
    source.addEventListener("job-event", receive);
    source.addEventListener("transaction-event", receive);
    source.addEventListener("error", () => {
      source.close();
      startPolling();
    });
    return () => {
      stopped = true;
      source.close();
      if (polling !== undefined) clearInterval(polling);
    };
  }, [apiResult, jobId, loadState]);

  const loadNextPage = useCallback(() => {
    if (apiResult.api === undefined || nextCursor === null || loadingNextPage) return;
    setLoadingNextPage(true);
    void apiResult.api
      .listJobEvents(jobId, { cursor: nextCursor, limit: EVENT_PAGE_SIZE })
      .then((timeline) => {
        setEvents((current) => mergeTimeline(current, timeline.items));
        setNextCursor(timeline.page.nextCursor);
      })
      .catch((reason: unknown) => setError(requestError(reason).message))
      .finally(() => setLoadingNextPage(false));
  }, [apiResult.api, jobId, loadingNextPage, nextCursor]);

  return (
    <JobDetailView
      {...(error === undefined ? {} : { error })}
      events={events}
      hasNextPage={nextCursor !== null}
      {...(job === undefined ? {} : { job })}
      loadState={loadState}
      loadingNextPage={loadingNextPage}
      onLoadNext={loadNextPage}
      onRetry={() => setRefreshKey((current) => current + 1)}
      {...(job === undefined
        ? {}
        : {
            ownerActions: <OwnerActions job={job} />,
          })}
    />
  );
}
