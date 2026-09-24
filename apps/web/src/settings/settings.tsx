"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiAuthSession,
  type ApiNotificationPreferences,
  type ApiSuccess,
  type ApiWebhookList,
} from "@ckb-automata/api-client";

import { useWalletSession } from "../ccc/session.tsx";
import { parseWebEnvironment } from "../environment.ts";
import { publishNotification } from "../shell/notification-center.tsx";
import {
  parseStoredSettingsSession,
  preferenceUpdate,
  preferencesDraft,
  SETTINGS_SESSION_KEY,
  type NotificationEvent,
  type PreferencesDraft,
  type StoredSettingsSession,
} from "./settings-model.ts";
import { SettingsView, type SettingsAccessStatus } from "./settings-view.tsx";

type Webhook = ApiWebhookList["items"][number];
type Delivery = ApiSuccess<"WebhookController_history">["items"][number];

function browserApiClient() {
  const environment = parseWebEnvironment({
    NEXT_PUBLIC_AUTOMATA_API_URL: process.env["NEXT_PUBLIC_AUTOMATA_API_URL"],
    NEXT_PUBLIC_CKB_NETWORK: process.env["NEXT_PUBLIC_CKB_NETWORK"],
  });
  return createApiClient({ baseUrl: environment.apiUrl });
}

function requestError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "The settings session expired. Sign in again.";
    if (error.status === 404) return "This private resource is not available to the current owner.";
    if (error.status >= 500) return "The settings service is temporarily unavailable.";
    return "The settings request was rejected. Review the values and retry.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "The settings request could not be completed.";
}

function notify(id: string, title: string, message: string) {
  publishNotification({ id, message, title, tone: "success" });
}

export function SettingsPanel() {
  const wallet = useWalletSession();
  const apiResult = useMemo(() => {
    try {
      return { api: browserApiClient(), error: undefined } as const;
    } catch {
      return { api: undefined, error: "The public testnet API is not configured." } as const;
    }
  }, []);
  const [status, setStatus] = useState<SettingsAccessStatus>("disconnected");
  const [settingsSession, setSettingsSession] = useState<StoredSettingsSession>();
  const [preferences, setPreferences] = useState<ApiNotificationPreferences>();
  const [draft, setDraft] = useState<PreferencesDraft>();
  const [webhooks, setWebhooks] = useState<readonly Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<readonly Delivery[]>();
  const [deliverySubscriptionId, setDeliverySubscriptionId] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [lastSecret, setLastSecret] = useState<{
    readonly label: string;
    readonly secret: string;
  }>();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const ownerRef = useRef(wallet.ownerLockHash);
  ownerRef.current = wallet.ownerLockHash;

  const forgetSession = useCallback((message?: string) => {
    window.sessionStorage.removeItem(SETTINGS_SESSION_KEY);
    setSettingsSession(undefined);
    setPreferences(undefined);
    setDraft(undefined);
    setWebhooks([]);
    setDeliveries(undefined);
    setDeliverySubscriptionId(undefined);
    setLastSecret(undefined);
    setError(message);
    setStatus("locked");
  }, []);

  useEffect(() => {
    if (settingsSession === undefined) return;
    const remaining = Date.parse(settingsSession.expiresAt) - Date.now();
    if (remaining <= 0) {
      forgetSession("The settings session expired. Sign in again.");
      return;
    }
    const timeout = window.setTimeout(
      () => forgetSession("The settings session expired. Sign in again."),
      remaining,
    );
    return () => window.clearTimeout(timeout);
  }, [forgetSession, settingsSession]);

  useEffect(() => {
    const ownerLockHash = wallet.ownerLockHash;
    if (wallet.status !== "ready" || ownerLockHash === undefined) {
      setStatus("disconnected");
      setSettingsSession(undefined);
      setPreferences(undefined);
      setDraft(undefined);
      setWebhooks([]);
      setDeliveries(undefined);
      setError(undefined);
      return;
    }
    if (apiResult.api === undefined) {
      setError(apiResult.error);
      setStatus("error");
      return;
    }
    const stored = parseStoredSettingsSession(
      window.sessionStorage.getItem(SETTINGS_SESSION_KEY),
      ownerLockHash,
    );
    if (stored === undefined) {
      window.sessionStorage.removeItem(SETTINGS_SESSION_KEY);
      setSettingsSession(undefined);
      setPreferences(undefined);
      setDraft(undefined);
      setWebhooks([]);
      setError(undefined);
      setStatus("locked");
      return;
    }

    let active = true;
    setStatus("loading");
    setError(undefined);
    void Promise.all([
      apiResult.api.getAuthSession(stored.token),
      apiResult.api.getNotificationPreferences(stored.token),
      apiResult.api.listWebhooks(stored.token),
    ])
      .then(([current, currentPreferences, currentWebhooks]) => {
        if (!active) return;
        if (
          current.ownerLockHash !== ownerLockHash ||
          currentPreferences.ownerLockHash !== ownerLockHash
        ) {
          forgetSession("The connected address does not own this settings session.");
          return;
        }
        setSettingsSession(stored);
        setPreferences(currentPreferences);
        setDraft(preferencesDraft(currentPreferences));
        setWebhooks(currentWebhooks.items);
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof ApiClientError && reason.status === 401) {
          forgetSession("The settings session expired. Sign in again.");
          return;
        }
        setError(requestError(reason));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [apiResult, forgetSession, retryKey, wallet.ownerLockHash, wallet.status]);

  const authenticate = useCallback(() => {
    const api = apiResult.api;
    const ownerLockHash = wallet.ownerLockHash;
    if (api === undefined || ownerLockHash === undefined) return;
    setStatus("authenticating");
    setError(undefined);
    void api
      .issueAuthChallenge({ ownerLockHash })
      .then(async (challenge) => {
        const proof = await wallet.signSettingsMessage(challenge.message);
        return api.verifyAuthChallenge({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          ownerLock: proof.ownerLock,
          signature: proof.signature,
        });
      })
      .then(async (created: ApiAuthSession) => {
        if (created.ownerLockHash !== ownerLockHash) {
          throw new Error("The settings session was issued for a different wallet address.");
        }
        const stored: StoredSettingsSession = {
          expiresAt: created.expiresAt,
          ownerLockHash: created.ownerLockHash,
          token: created.sessionToken,
        };
        window.sessionStorage.setItem(SETTINGS_SESSION_KEY, JSON.stringify(stored));
        const [currentPreferences, currentWebhooks] = await Promise.all([
          api.getNotificationPreferences(stored.token),
          api.listWebhooks(stored.token),
        ]);
        if (ownerRef.current !== stored.ownerLockHash) {
          window.sessionStorage.removeItem(SETTINGS_SESSION_KEY);
          throw new Error("The connected wallet address changed during authentication.");
        }
        setSettingsSession(stored);
        setPreferences(currentPreferences);
        setDraft(preferencesDraft(currentPreferences));
        setWebhooks(currentWebhooks.items);
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        setError(requestError(reason));
        setStatus("locked");
      });
  }, [apiResult.api, wallet]);

  const authorized = useCallback(
    async <Result,>(action: string, request: (token: string) => Promise<Result>) => {
      if (settingsSession === undefined) throw new Error("Settings authentication is required.");
      setBusyAction(action);
      setError(undefined);
      try {
        const result = await request(settingsSession.token);
        if (ownerRef.current !== settingsSession.ownerLockHash) {
          throw new Error("The connected wallet address changed during the request.");
        }
        return result;
      } catch (reason) {
        if (ownerRef.current !== settingsSession.ownerLockHash) throw reason;
        if (reason instanceof ApiClientError && reason.status === 401) {
          forgetSession("The settings session expired. Sign in again.");
        } else {
          setError(requestError(reason));
        }
        throw reason;
      } finally {
        setBusyAction(undefined);
      }
    },
    [forgetSession, settingsSession],
  );

  const savePreferences = useCallback(
    (emailAddress: string) => {
      if (apiResult.api === undefined || draft === undefined) return;
      const nextDraft = { ...draft, email: { ...draft.email, address: emailAddress } };
      void authorized("preferences", (token) =>
        apiResult.api!.updateNotificationPreferences(token, preferenceUpdate(nextDraft)),
      )
        .then((updated) => {
          setPreferences(updated);
          setDraft(preferencesDraft(updated));
          notify(
            "settings-preferences",
            "Notifications saved",
            "Private preferences were updated.",
          );
        })
        .catch(() => undefined);
    },
    [apiResult.api, authorized, draft],
  );

  const registerWebhook = useCallback(
    (endpoint: string, eventTypes: readonly NotificationEvent[]) => {
      if (apiResult.api === undefined) return;
      void authorized("register-webhook", (token) =>
        apiResult.api!.registerWebhook(token, { endpoint, eventTypes }),
      )
        .then((registered) => {
          const { secret, ...webhook } = registered;
          setWebhooks((current) => [webhook, ...current]);
          setLastSecret({ label: "Webhook registered", secret });
          notify("settings-webhook", "Webhook registered", "The endpoint is enabled.");
        })
        .catch(() => undefined);
    },
    [apiResult.api, authorized],
  );

  const updateWebhook = useCallback(
    (
      subscriptionId: string,
      update: Readonly<{ enabled?: boolean; eventTypes?: readonly NotificationEvent[] }>,
    ) => {
      if (apiResult.api === undefined) return;
      void authorized(`webhook-${subscriptionId}`, (token) =>
        apiResult.api!.updateWebhook(token, subscriptionId, update),
      )
        .then((updated) => {
          setWebhooks((current) =>
            current.map((webhook) => (webhook.id === subscriptionId ? updated : webhook)),
          );
          notify("settings-webhook-update", "Webhook updated", "Delivery settings were saved.");
        })
        .catch(() => undefined);
    },
    [apiResult.api, authorized],
  );

  const rotateWebhook = useCallback(
    (subscriptionId: string) => {
      if (apiResult.api === undefined) return;
      void authorized(`rotate-${subscriptionId}`, (token) =>
        apiResult.api!.rotateWebhookSecret(token, subscriptionId),
      )
        .then((rotation) => {
          setWebhooks((current) =>
            current.map((webhook) =>
              webhook.id === subscriptionId
                ? {
                    ...webhook,
                    secretVersion: rotation.secretVersion,
                    updatedAt: rotation.rotatedAt,
                  }
                : webhook,
            ),
          );
          setLastSecret({ label: "Webhook secret rotated", secret: rotation.secret });
        })
        .catch(() => undefined);
    },
    [apiResult.api, authorized],
  );

  const loadDeliveries = useCallback(
    (subscriptionId: string) => {
      if (apiResult.api === undefined) return;
      void authorized(`deliveries-${subscriptionId}`, (token) =>
        apiResult.api!.webhookDeliveries(token, subscriptionId, { limit: 10 }),
      )
        .then((history) => {
          setDeliverySubscriptionId(subscriptionId);
          setDeliveries(history.items);
        })
        .catch(() => undefined);
    },
    [apiResult.api, authorized],
  );

  const replayDelivery = useCallback(
    (subscriptionId: string, deliveryId: string) => {
      if (apiResult.api === undefined) return;
      void authorized(`replay-${deliveryId}`, (token) =>
        apiResult.api!.replayWebhookDelivery(token, subscriptionId, deliveryId),
      )
        .then((replayed) => {
          setDeliveries((current) => (current === undefined ? [replayed] : [replayed, ...current]));
          notify("settings-replay", "Delivery replayed", "A new signed delivery run was created.");
        })
        .catch(() => undefined);
    },
    [apiResult.api, authorized],
  );

  const reset = useCallback(() => {
    if (apiResult.api === undefined) return;
    void authorized("reset", (token) => apiResult.api!.resetNotificationPreferences(token))
      .then((resetPreferences) => {
        setPreferences(resetPreferences);
        setDraft(preferencesDraft(resetPreferences));
        setWebhooks([]);
        setDeliveries(undefined);
        setDeliverySubscriptionId(undefined);
        setLastSecret(undefined);
        notify(
          "settings-reset",
          "Private settings reset",
          "Notifications and webhooks were deleted.",
        );
      })
      .catch(() => undefined);
  }, [apiResult.api, authorized]);

  const signOut = useCallback(() => {
    if (apiResult.api === undefined || settingsSession === undefined) return;
    setBusyAction("sign-out");
    setError(undefined);
    void apiResult.api
      .revokeAuthSession(settingsSession.token)
      .then(() => forgetSession())
      .catch((reason: unknown) => {
        if (reason instanceof ApiClientError && reason.status === 401) forgetSession();
        else setError(requestError(reason));
      })
      .finally(() => setBusyAction(undefined));
  }, [apiResult.api, forgetSession, settingsSession]);

  return (
    <SettingsView
      {...(wallet.address === undefined ? {} : { address: wallet.address })}
      {...(busyAction === undefined ? {} : { busyAction })}
      {...(deliveries === undefined ? {} : { deliveries })}
      {...(deliverySubscriptionId === undefined ? {} : { deliverySubscriptionId })}
      {...(error === undefined ? {} : { error })}
      {...(settingsSession === undefined ? {} : { expiresAt: settingsSession.expiresAt })}
      {...(lastSecret === undefined ? {} : { lastSecret })}
      network={preferences?.network ?? "ckb_testnet"}
      onAuthenticate={authenticate}
      onConnect={wallet.open}
      onDraftChange={setDraft}
      onLoadDeliveries={loadDeliveries}
      onRegisterWebhook={registerWebhook}
      onReplayDelivery={replayDelivery}
      onReset={reset}
      onRetry={() => setRetryKey((current) => current + 1)}
      onRotateWebhook={rotateWebhook}
      onSavePreferences={savePreferences}
      onSignOut={signOut}
      onUpdateWebhook={updateWebhook}
      {...(wallet.ownerLockHash === undefined ? {} : { ownerLockHash: wallet.ownerLockHash })}
      {...(preferences === undefined ? {} : { preferences })}
      {...(draft === undefined ? {} : { preferencesDraft: draft })}
      status={status}
      webhooks={webhooks}
    />
  );
}
