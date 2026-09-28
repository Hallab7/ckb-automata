"use client";

import { RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { createApiClient } from "@ckb-automata/api-client";
import { Button, InlineNotice } from "@ckb-automata/ui";

import { AutomationDashboardSkeleton } from "./dashboard/dashboard-view.tsx";
import { AutomationDetailSkeleton } from "./detail/job-detail-view.tsx";
import {
  assertPublicDeploymentIdentity,
  requiresPublicDeploymentVerification,
} from "./deployment-identity.ts";
import { browserWebEnvironment } from "./environment.ts";

type GateState = "checking" | "ready" | "rejected" | "unavailable";

export function PublicDeploymentGate({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const requiresVerification = requiresPublicDeploymentVerification(pathname);
  const [state, setState] = useState<GateState>("checking");
  const [attempt, setAttempt] = useState(0);
  const verify = useCallback(async () => {
    setState("checking");
    let environment;
    try {
      environment = browserWebEnvironment();
    } catch {
      setState("rejected");
      return;
    }
    let metadata;
    try {
      metadata = await createApiClient({ baseUrl: environment.apiUrl }).network();
    } catch {
      setState("unavailable");
      return;
    }
    try {
      assertPublicDeploymentIdentity(metadata, environment);
      setState("ready");
    } catch {
      setState("rejected");
    }
  }, []);

  useEffect(() => {
    if (!requiresVerification) return;
    void verify();
  }, [attempt, requiresVerification, verify]);

  if (!requiresVerification) return children;
  if (state === "ready") return children;
  if (state === "checking") {
    if (pathname === "/automations") return <AutomationDashboardSkeleton />;
    if (/^\/automations\/[^/]+$/.test(pathname) && pathname !== "/automations/new") {
      return <AutomationDetailSkeleton />;
    }
    return (
      <section aria-busy="true" aria-live="polite" className="app-deployment-gate">
        <span className="app-deployment-gate__spinner" />
        <h1>Verifying public deployment</h1>
        <p>Checking the CKB testnet genesis and contract manifest before loading live data.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="deployment-gate-title" className="app-page">
      <h1 id="deployment-gate-title">
        {state === "unavailable" ? "Something went wrong" : "Deployment identity mismatch"}
      </h1>
      <InlineNotice
        title={state === "unavailable" ? "Unable to load this page" : "Live access is blocked"}
        tone="danger"
      >
        {state === "unavailable" ? (
          <p>Something went wrong. Please try again.</p>
        ) : (
          <p>
            The configured backend did not prove the expected CKB Testnet and contract manifest.
            Wallet and transaction workflows remain unavailable.
          </p>
        )}
      </InlineNotice>
      <div>
        <Button
          icon={<RefreshCw aria-hidden="true" size={16} />}
          onClick={() => setAttempt((current) => current + 1)}
        >
          Try again
        </Button>
      </div>
    </section>
  );
}
