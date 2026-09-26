"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createApiClient,
  type ApiJob,
  type ApiJobEvents,
  type ApiJobTerms,
  type AutomataApiClient,
} from "@ckb-automata/api-client";

import { browserWebEnvironment } from "../environment.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import { detailRequestError } from "../request-errors.ts";
import { decodeDetailStreamEvent } from "../stream-reducers.ts";
import { JobDetailView, type JobDetailLoadState } from "./job-detail-view.tsx";
import { mergeTimeline } from "./job-detail-model.ts";
import { OwnerActions } from "./owner-actions.tsx";

const EVENT_PAGE_SIZE = 50;
const EVENT_POLL_MS = 5_000;

function streamUrl(baseUrl: string, jobId: string): string {
  const url = new URL("v1/events/stream", baseUrl);
  url.searchParams.set("jobId", jobId);
  return url.toString();
}

export function AutomationDetail({ jobId }: Readonly<{ jobId: string }>) {
  const apiResult = useMemo(() => {
    try {
      const environment = browserWebEnvironment();
      return {
        api: createApiClient({ baseUrl: environment.apiUrl }),
        sseUrl: environment.sseUrl,
        error: undefined,
      } as const;
    } catch {
      return {
        api: undefined,
        sseUrl: undefined,
        error: "The public testnet API is not configured.",
      } as const;
    }
  }, []);
  const [job, setJob] = useState<ApiJob>();
  const [events, setEvents] = useState<ApiJobEvents["items"]>([]);
  const [terms, setTerms] = useState<ApiJobTerms>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<JobDetailLoadState>("loading");
  const [loadingNextPage, setLoadingNextPage] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [automationTitle, setAutomationTitle] = useState<string>();

  useEffect(() => {
    setAutomationTitle(readAutomationTitles(window.localStorage)[jobId]);
  }, [jobId]);

  const load = useCallback(
    async (api: AutomataApiClient) => {
      const [nextJob, timeline, nextTerms] = await Promise.all([
        api.getJob(jobId),
        api.listJobEvents(jobId, { limit: EVENT_PAGE_SIZE }),
        api.getJobTerms(jobId).catch(() => undefined),
      ]);
      setJob(nextJob);
      setEvents(timeline.items);
      setNextCursor(timeline.page.nextCursor);
      setTerms(nextTerms);
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
        const failure = detailRequestError(reason);
        setError(failure.message);
        setLoadState(failure.state);
      });
    return () => {
      active = false;
    };
  }, [apiResult, load, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready" || apiResult.api === undefined || apiResult.sseUrl === undefined) {
      return;
    }
    let stopped = false;
    let polling: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      try {
        const [nextJob, timeline, nextTerms] = await Promise.all([
          apiResult.api!.getJob(jobId),
          apiResult.api!.listJobEvents(jobId, { limit: 100 }),
          apiResult.api!.getJobTerms(jobId).catch(() => undefined),
        ]);
        if (stopped) return;
        setJob(nextJob);
        setEvents((current) => mergeTimeline(current, timeline.items));
        setTerms(nextTerms);
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

    const source = new EventSource(streamUrl(apiResult.sseUrl, jobId));
    const receive = (event: Event) => {
      const decoded = decodeDetailStreamEvent((event as MessageEvent<string>).data, jobId);
      if (decoded.kind === "invalid") {
        source.close();
        startPolling();
        return;
      }
      if (decoded.kind === "ignored" || decoded.value === undefined || stopped) return;
      setEvents((current) => mergeTimeline(current, [decoded.value!]));
      void apiResult
        .api!.getJob(jobId)
        .then((nextJob) => {
          if (!stopped) setJob(nextJob);
        })
        .catch(() => {
          source.close();
          startPolling();
        });
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
      .catch((reason: unknown) => setError(detailRequestError(reason).message))
      .finally(() => setLoadingNextPage(false));
  }, [apiResult.api, jobId, loadingNextPage, nextCursor]);

  return (
    <JobDetailView
      {...(automationTitle === undefined ? {} : { automationTitle })}
      {...(error === undefined ? {} : { error })}
      events={events}
      hasNextPage={nextCursor !== null}
      {...(job === undefined ? {} : { job })}
      loadState={loadState}
      loadingNextPage={loadingNextPage}
      onLoadNext={loadNextPage}
      onRetry={() => setRefreshKey((current) => current + 1)}
      {...(terms === undefined ? {} : { recipientAmount: terms.payout.perExecution })}
      {...(job === undefined
        ? {}
        : {
            ownerActions: <OwnerActions job={job} />,
          })}
    />
  );
}
