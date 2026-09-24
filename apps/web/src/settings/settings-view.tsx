"use client";

import {
  Bell,
  BellOff,
  CircleAlert,
  ExternalLink,
  KeyRound,
  Link2,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type {
  ApiNotificationPreferences,
  ApiSuccess,
  ApiWebhookList,
} from "@ckb-automata/api-client";
import { Button, CheckboxField, Dialog, InlineNotice, TextField } from "@ckb-automata/ui";

import { ckbTestnetAddressUrl, shortenCkbAddress } from "../ccc/wallet-display.ts";
import {
  NOTIFICATION_EVENTS,
  toggleNotificationEvent,
  type NotificationEvent,
  type PreferencesDraft,
} from "./settings-model.ts";

type Webhook = ApiWebhookList["items"][number];
type Delivery = ApiSuccess<"WebhookController_history">["items"][number];

export type SettingsAccessStatus =
  "authenticating" | "disconnected" | "error" | "loading" | "locked" | "ready";

export interface SettingsViewProperties {
  readonly address?: string;
  readonly busyAction?: string;
  readonly deliveries?: readonly Delivery[];
  readonly deliverySubscriptionId?: string;
  readonly error?: string;
  readonly expiresAt?: string;
  readonly lastSecret?: { readonly label: string; readonly secret: string };
  readonly network?: string;
  readonly onAuthenticate: () => void;
  readonly onConnect: () => void;
  readonly onDraftChange: (draft: PreferencesDraft) => void;
  readonly onLoadDeliveries: (subscriptionId: string) => void;
  readonly onRegisterWebhook: (endpoint: string, eventTypes: readonly NotificationEvent[]) => void;
  readonly onReplayDelivery: (subscriptionId: string, deliveryId: string) => void;
  readonly onReset: () => void;
  readonly onRetry: () => void;
  readonly onRotateWebhook: (subscriptionId: string) => void;
  readonly onSavePreferences: (emailAddress: string) => void;
  readonly onSignOut: () => void;
  readonly onUpdateWebhook: (
    subscriptionId: string,
    update: Readonly<{ enabled?: boolean; eventTypes?: readonly NotificationEvent[] }>,
  ) => void;
  readonly ownerLockHash?: string;
  readonly preferences?: ApiNotificationPreferences;
  readonly preferencesDraft?: PreferencesDraft;
  readonly status: SettingsAccessStatus;
  readonly webhooks?: readonly Webhook[];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function displayEndpoint(value: string): string {
  const endpoint = new URL(value);
  return `${endpoint.host}${endpoint.pathname === "/" ? "" : endpoint.pathname}`;
}

function EventSelection({
  disabled,
  idPrefix,
  minimumOne = false,
  onChange,
  selected,
}: Readonly<{
  disabled?: boolean;
  idPrefix: string;
  minimumOne?: boolean;
  onChange: (events: readonly NotificationEvent[]) => void;
  selected: readonly NotificationEvent[];
}>) {
  return (
    <div className="settings-event-grid">
      {NOTIFICATION_EVENTS.map((event) => (
        <CheckboxField
          checked={selected.includes(event.id)}
          disabled={
            disabled || (minimumOne && selected.length === 1 && selected.includes(event.id))
          }
          id={`${idPrefix}-${event.id}`}
          key={event.id}
          label={event.label}
          onChange={(input) =>
            onChange(toggleNotificationEvent(selected, event.id, input.target.checked))
          }
        />
      ))}
    </div>
  );
}

function AccessGate({
  error,
  onAuthenticate,
  onConnect,
  onRetry,
  status,
}: Pick<SettingsViewProperties, "error" | "onAuthenticate" | "onConnect" | "onRetry" | "status">) {
  if (status === "ready") return null;
  if (status === "disconnected") {
    return (
      <InlineNotice title="Wallet connection required" tone="warning">
        <p>Private notification settings are available only to the connected owner.</p>
        <Button onClick={onConnect}>Connect wallet</Button>
      </InlineNotice>
    );
  }
  if (status === "locked") {
    return (
      <InlineNotice title="Owner authentication required" tone="info">
        <p>
          {error ??
            "The wallet signature creates an off-chain settings session and cannot authorize CKB."}
        </p>
        <Button icon={<KeyRound aria-hidden="true" size={16} />} onClick={onAuthenticate}>
          Sign in to settings
        </Button>
      </InlineNotice>
    );
  }
  if (status === "authenticating" || status === "loading") {
    return (
      <div className="settings-loading" aria-live="polite">
        <RefreshCw aria-hidden="true" size={20} />
        {status === "authenticating" ? "Waiting for wallet approval..." : "Loading settings..."}
      </div>
    );
  }
  return (
    <InlineNotice title="Settings unavailable" tone="danger">
      <p>{error ?? "Private settings could not be loaded."}</p>
      <Button icon={<RefreshCw aria-hidden="true" size={16} />} onClick={onRetry}>
        Retry
      </Button>
    </InlineNotice>
  );
}

function PreferencesSection({
  busyAction,
  draft,
  maskedEmail,
  onDraftChange,
  onSave,
}: Readonly<{
  busyAction?: string;
  draft: PreferencesDraft;
  maskedEmail: string | null;
  onDraftChange: (draft: PreferencesDraft) => void;
  onSave: (email: string) => void;
}>) {
  const [emailAddress, setEmailAddress] = useState("");
  const valid =
    (!draft.browser.enabled || draft.browser.eventTypes.length > 0) &&
    (!draft.email.enabled ||
      (draft.email.eventTypes.length > 0 && (maskedEmail !== null || emailAddress.trim() !== "")));
  return (
    <section className="settings-section" aria-labelledby="notification-settings-title">
      <header className="settings-section__heading">
        <div>
          <h2 id="notification-settings-title">Notifications</h2>
          <p>All channels start disabled and require an explicit opt-in.</p>
        </div>
        {draft.browser.enabled || draft.email.enabled ? (
          <Bell aria-hidden="true" size={20} />
        ) : (
          <BellOff aria-hidden="true" size={20} />
        )}
      </header>

      <div className="settings-channel">
        <CheckboxField
          checked={draft.browser.enabled}
          description="Show alerts while this application is open."
          id="browser-notifications"
          label="Browser notifications"
          onChange={(event) =>
            onDraftChange({
              ...draft,
              browser: { ...draft.browser, enabled: event.target.checked },
            })
          }
        />
        <EventSelection
          disabled={!draft.browser.enabled}
          idPrefix="browser-event"
          onChange={(eventTypes) =>
            onDraftChange({ ...draft, browser: { ...draft.browser, eventTypes } })
          }
          selected={draft.browser.eventTypes}
        />
      </div>

      <div className="settings-channel">
        <CheckboxField
          checked={draft.email.enabled}
          description="Send selected events to the private destination below."
          id="email-notifications"
          label="Email notifications"
          onChange={(event) =>
            onDraftChange({
              ...draft,
              email: { ...draft.email, enabled: event.target.checked },
            })
          }
        />
        <TextField
          autoComplete="email"
          disabled={!draft.email.enabled}
          hint={maskedEmail === null ? "No email stored" : `Stored destination: ${maskedEmail}`}
          label="Email address"
          onChange={(event) => setEmailAddress(event.target.value)}
          placeholder={maskedEmail ?? "alerts@example.com"}
          type="email"
          value={emailAddress}
        />
        <EventSelection
          disabled={!draft.email.enabled}
          idPrefix="email-event"
          onChange={(eventTypes) =>
            onDraftChange({ ...draft, email: { ...draft.email, eventTypes } })
          }
          selected={draft.email.eventTypes}
        />
      </div>

      <div className="settings-actions">
        <Button disabled={busyAction !== undefined || !valid} onClick={() => onSave(emailAddress)}>
          {busyAction === "preferences" ? "Saving..." : "Save notifications"}
        </Button>
      </div>
    </section>
  );
}

function DeliveryHistory({
  busyAction,
  deliveries,
  onReplay,
}: Readonly<{
  busyAction?: string;
  deliveries: readonly Delivery[];
  onReplay: (deliveryId: string) => void;
}>) {
  if (deliveries.length === 0) return <p className="settings-muted">No deliveries recorded.</p>;
  return (
    <div className="settings-deliveries">
      {deliveries.map((delivery) => (
        <div className="settings-delivery" key={delivery.id}>
          <div>
            <strong>{delivery.notificationType.replaceAll("_", " ")}</strong>
            <span>
              {delivery.status} | attempt {delivery.attemptNumber}
            </span>
          </div>
          {delivery.status === "failed" ? (
            <Button
              disabled={busyAction !== undefined}
              onClick={() => onReplay(delivery.id)}
              tone="secondary"
            >
              Replay
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function WebhookSection({
  busyAction,
  deliveries,
  deliverySubscriptionId,
  onLoadDeliveries,
  onRegister,
  onReplayDelivery,
  onRotate,
  onUpdate,
  webhooks,
}: Readonly<{
  busyAction?: string;
  deliveries?: readonly Delivery[];
  deliverySubscriptionId?: string;
  onLoadDeliveries: (subscriptionId: string) => void;
  onRegister: (endpoint: string, events: readonly NotificationEvent[]) => void;
  onReplayDelivery: (subscriptionId: string, deliveryId: string) => void;
  onRotate: (subscriptionId: string) => void;
  onUpdate: SettingsViewProperties["onUpdateWebhook"];
  webhooks: readonly Webhook[];
}>) {
  const [endpoint, setEndpoint] = useState("");
  const [events, setEvents] = useState<readonly NotificationEvent[]>(
    NOTIFICATION_EVENTS.map(({ id }) => id),
  );
  return (
    <section className="settings-section" aria-labelledby="webhook-settings-title">
      <header className="settings-section__heading">
        <div>
          <h2 id="webhook-settings-title">Webhooks</h2>
          <p>Signed notification delivery to public HTTPS endpoints.</p>
        </div>
        <Link2 aria-hidden="true" size={20} />
      </header>

      <form
        className="settings-webhook-form"
        onSubmit={(event) => {
          event.preventDefault();
          onRegister(endpoint, events);
        }}
      >
        <TextField
          label="Endpoint"
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://hooks.example.com/automata"
          required
          type="url"
          value={endpoint}
        />
        <EventSelection idPrefix="new-webhook-event" onChange={setEvents} selected={events} />
        <Button
          disabled={busyAction !== undefined || events.length === 0}
          icon={<Plus aria-hidden="true" size={16} />}
          type="submit"
        >
          {busyAction === "register-webhook" ? "Registering..." : "Register webhook"}
        </Button>
      </form>

      <div className="settings-webhooks">
        {webhooks.length === 0 ? (
          <p className="settings-muted">No webhook endpoints registered.</p>
        ) : null}
        {webhooks.map((webhook) => {
          const showingDeliveries = deliverySubscriptionId === webhook.id;
          return (
            <article className="settings-webhook" key={webhook.id}>
              <div className="settings-webhook__heading">
                <div>
                  <strong title={webhook.endpoint}>{displayEndpoint(webhook.endpoint)}</strong>
                  <span>
                    Secret version {webhook.secretVersion} |{" "}
                    {webhook.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <CheckboxField
                  checked={webhook.enabled}
                  id={`webhook-enabled-${webhook.id}`}
                  label="Enabled"
                  onChange={(event) => onUpdate(webhook.id, { enabled: event.target.checked })}
                />
              </div>
              <EventSelection
                disabled={busyAction !== undefined || !webhook.enabled}
                idPrefix={`webhook-event-${webhook.id}`}
                minimumOne
                onChange={(eventTypes) => onUpdate(webhook.id, { eventTypes })}
                selected={webhook.eventTypes}
              />
              <div className="settings-actions">
                <Button
                  disabled={busyAction !== undefined}
                  icon={<RotateCw aria-hidden="true" size={15} />}
                  onClick={() => onRotate(webhook.id)}
                  tone="secondary"
                >
                  Rotate secret
                </Button>
                <Button
                  disabled={busyAction !== undefined}
                  onClick={() => onLoadDeliveries(webhook.id)}
                  tone="ghost"
                >
                  Delivery history
                </Button>
              </div>
              {showingDeliveries && deliveries !== undefined ? (
                <DeliveryHistory
                  {...(busyAction === undefined ? {} : { busyAction })}
                  deliveries={deliveries}
                  onReplay={(deliveryId) => onReplayDelivery(webhook.id, deliveryId)}
                />
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DangerSection({
  busyAction,
  onReset,
}: Readonly<{ busyAction?: string; onReset: () => void }>) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <section className="settings-section settings-danger" aria-labelledby="reset-settings-title">
      <header className="settings-section__heading">
        <div>
          <h2 id="reset-settings-title">Reset private settings</h2>
          <p>Deletes notification preferences, webhooks, and webhook delivery history.</p>
        </div>
        <CircleAlert aria-hidden="true" size={20} />
      </header>
      <Dialog
        description="This affects only private off-chain settings for the authenticated owner. Automations and on-chain funds are unchanged."
        title="Reset private settings"
        trigger={
          <Button icon={<Trash2 aria-hidden="true" size={16} />} tone="danger">
            Reset settings
          </Button>
        }
        footer={
          <Button
            disabled={confirmation !== "RESET" || busyAction !== undefined}
            onClick={onReset}
            tone="danger"
          >
            {busyAction === "reset" ? "Resetting..." : "Delete private settings"}
          </Button>
        }
      >
        <TextField
          autoComplete="off"
          label="Type RESET to confirm"
          onChange={(event) => setConfirmation(event.target.value)}
          value={confirmation}
        />
      </Dialog>
    </section>
  );
}

export function SettingsView(properties: SettingsViewProperties) {
  const {
    address,
    busyAction,
    deliveries,
    deliverySubscriptionId,
    error,
    expiresAt,
    lastSecret,
    network,
    onAuthenticate,
    onConnect,
    onDraftChange,
    onLoadDeliveries,
    onRegisterWebhook,
    onReplayDelivery,
    onReset,
    onRetry,
    onRotateWebhook,
    onSavePreferences,
    onSignOut,
    onUpdateWebhook,
    ownerLockHash,
    preferences,
    preferencesDraft,
    status,
    webhooks,
  } = properties;
  return (
    <section className="app-page settings-view" aria-labelledby="settings-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <h1 id="settings-title">Settings</h1>
          <p>Owner-scoped alerts, webhooks, and access</p>
        </div>
      </header>

      <section className="settings-summary" aria-label="Network and privacy">
        <div>
          <Network aria-hidden="true" size={18} />
          <span>Network</span>
          <strong>{network === "ckb_dev" ? "Local CKB" : "CKB Testnet"}</strong>
        </div>
        <div>
          <ShieldCheck aria-hidden="true" size={18} />
          <span>Privacy</span>
          <strong>Owner isolated</strong>
        </div>
        {address === undefined ? null : (
          <div>
            <KeyRound aria-hidden="true" size={18} />
            <span>Wallet</span>
            <a href={ckbTestnetAddressUrl(address)} rel="noreferrer" target="_blank">
              {shortenCkbAddress(address)} <ExternalLink aria-hidden="true" size={13} />
            </a>
          </div>
        )}
      </section>

      <AccessGate
        {...(error === undefined ? {} : { error })}
        onAuthenticate={onAuthenticate}
        onConnect={onConnect}
        onRetry={onRetry}
        status={status}
      />

      {status === "ready" && error !== undefined ? (
        <InlineNotice title="Action failed" tone="danger">
          <p>{error}</p>
        </InlineNotice>
      ) : null}
      {status === "ready" && lastSecret !== undefined ? (
        <InlineNotice title={lastSecret.label} tone="warning">
          <p>This signing secret is shown once.</p>
          <code className="settings-secret">{lastSecret.secret}</code>
        </InlineNotice>
      ) : null}

      {status === "ready" && preferences !== undefined && preferencesDraft !== undefined ? (
        <>
          <section className="settings-session" aria-labelledby="settings-session-title">
            <div>
              <h2 id="settings-session-title">Settings session</h2>
              <dl>
                <div>
                  <dt>Owner lock</dt>
                  <dd>{ownerLockHash}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{expiresAt === undefined ? "Unknown" : `${formatDate(expiresAt)} UTC`}</dd>
                </div>
              </dl>
            </div>
            <Button
              disabled={busyAction !== undefined}
              icon={<LogOut aria-hidden="true" size={16} />}
              onClick={onSignOut}
              tone="secondary"
            >
              Sign out
            </Button>
          </section>
          <PreferencesSection
            {...(busyAction === undefined ? {} : { busyAction })}
            draft={preferencesDraft}
            maskedEmail={preferences.channels.email.address}
            onDraftChange={onDraftChange}
            onSave={onSavePreferences}
          />
          <WebhookSection
            {...(busyAction === undefined ? {} : { busyAction })}
            {...(deliveries === undefined ? {} : { deliveries })}
            {...(deliverySubscriptionId === undefined ? {} : { deliverySubscriptionId })}
            onLoadDeliveries={onLoadDeliveries}
            onRegister={onRegisterWebhook}
            onReplayDelivery={onReplayDelivery}
            onRotate={onRotateWebhook}
            onUpdate={onUpdateWebhook}
            webhooks={webhooks ?? []}
          />
          <DangerSection {...(busyAction === undefined ? {} : { busyAction })} onReset={onReset} />
        </>
      ) : null}
    </section>
  );
}
