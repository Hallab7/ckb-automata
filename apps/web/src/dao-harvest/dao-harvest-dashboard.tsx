"use client";

import { ArrowUpRight, Landmark, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { createApiClient, type ApiDaoHarvest } from "@ckb-automata/api-client";
import { Button, InlineNotice } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { browserWebEnvironment } from "../environment.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import { daoHarvestPresentation, formatHarvestPrincipal } from "./presentation.ts";

export function DaoHarvestDashboard() {
  const session = useWalletSession();
  const client = useMemo(() => {
    try {
      return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
    } catch {
      return undefined;
    }
  }, []);
  const [items, setItems] = useState<readonly ApiDaoHarvest[]>([]);
  const [state, setState] = useState<"error" | "loading" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => setTitles(readAutomationTitles(window.localStorage)), [items]);
  useEffect(() => {
    if (client === undefined) {
      setState("error");
      return;
    }
    let active = true;
    setState("loading");
    void client
      .listDaoHarvest({ limit: 20 })
      .then((response) => {
        if (!active) return;
        setItems(response.items ?? []);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [client, retry]);

  const visible =
    session.status === "ready" && session.ownerLockHash !== undefined
      ? items.filter((item) => item.ownerLockHash === session.ownerLockHash)
      : items;

  return (
    <section className="harvest-dashboard" aria-labelledby="harvest-dashboard-title">
      <header className="harvest-dashboard__header">
        <div>
          <span className="harvest-dashboard__icon">
            <Landmark size={18} />
          </span>
          <div>
            <h2 id="harvest-dashboard-title">DAO compensation</h2>
            <p>Original amounts kept in DAO harvest automations.</p>
          </div>
        </div>
        <Link className="ui-button ui-button--secondary" href="/automations/new/dao-harvest">
          New harvest
        </Link>
      </header>
      {state === "loading" ? (
        <div
          className="harvest-dashboard__skeleton"
          aria-label="Loading DAO compensation automations"
        >
          <span />
          <span />
        </div>
      ) : null}
      {state === "error" ? (
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
      ) : null}
      {state === "ready" && visible.length === 0 ? (
        <div className="harvest-dashboard__empty">
          <p>No DAO compensation automations yet.</p>
        </div>
      ) : null}
      {state === "ready" && visible.length > 0 ? (
        <div className="harvest-dashboard__rows">
          {visible.map((item) => {
            const presentation = daoHarvestPresentation(item);
            return (
              <Link
                className="harvest-row"
                href={`/automations/dao-harvest/${encodeURIComponent(item.jobId)}`}
                key={item.jobId}
              >
                <div>
                  <strong>{titles[item.jobId] ?? "Harvest compensation"}</strong>
                  <span>{presentation.action}</span>
                </div>
                <div>
                  <span
                    className={`ui-status ui-status--${presentation.status === "recovery" ? "danger" : presentation.status === "completed" ? "neutral" : "info"}`}
                  >
                    {presentation.statusLabel}
                  </span>
                  <strong>{formatHarvestPrincipal(item.principal)}</strong>
                  <small>
                    {presentation.completedCycles} of {presentation.totalCycles} harvests
                  </small>
                </div>
                <ArrowUpRight aria-hidden="true" size={17} />
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
