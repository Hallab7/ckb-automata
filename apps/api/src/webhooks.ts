import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { and, asc, desc, eq, lt, lte } from "drizzle-orm";

import type { AutomataEnvironment } from "@ckb-automata/config";
import type { AutomataMetrics } from "@ckb-automata/telemetry";

import { AuthService } from "./auth.ts";
import type { AutomataDatabase } from "./database/client.ts";
import {
  jobEvents,
  jobs,
  notificationSubscriptions,
  webhookDeliveries,
} from "./database/schema.ts";
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "./preferences.ts";
import { decodeEncryptionKey, decryptSecret, encryptSecret } from "./secret-box.ts";

export const WEBHOOK_MAX_ATTEMPTS = 4;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 25;
const MAX_RESPONSE_EXCERPT_BYTES = 512;

type SubscriptionRow = typeof notificationSubscriptions.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;
type EventRow = typeof jobEvents.$inferSelect;

interface WebhookCredential {
  readonly endpoint: string;
  readonly secret: string;
}

interface RegisterInput {
  readonly endpoint: string;
  readonly eventTypes: readonly NotificationEventType[];
}

interface UpdateInput {
  readonly enabled?: boolean;
  readonly eventTypes?: readonly NotificationEventType[];
}

interface ResolvedAddress {
  readonly address: string;
}

export interface WebhookServiceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomIv?: () => Buffer;
  readonly randomUuid?: () => string;
  readonly resolveHostname?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly timeoutMs?: number;
  readonly metrics?: Pick<AutomataMetrics, "webhookDeliveriesTotal">;
}

export interface WebhookSubscriptionResponse {
  readonly createdAt: string;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly eventTypes: readonly NotificationEventType[];
  readonly id: string;
  readonly secretVersion: number;
  readonly updatedAt: string;
}

export interface WebhookRegistrationResponse extends WebhookSubscriptionResponse {
  readonly secret: string;
}

export interface WebhookDeliveryResponse {
  readonly attemptNumber: number;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly errorCode: string | null;
  readonly eventId: string;
  readonly finishedAt: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly nextAttemptAt: string | null;
  readonly notificationType: NotificationEventType;
  readonly replayNumber: number;
  readonly responseCode: number | null;
  readonly responseExcerpt: string | null;
  readonly status: "pending" | "retry_scheduled" | "delivered" | "failed";
}

export interface WebhookDeliveryRun {
  readonly items: readonly WebhookDeliveryResponse[];
  readonly subscriptionId: string;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_WEBHOOK_REQUEST",
    message,
  });
}

function missing(): NotFoundException {
  return new NotFoundException({
    status: "not_found",
    code: "WEBHOOK_NOT_FOUND",
    message: "webhook subscription or delivery was not found",
  });
}

function unavailable(message: string): ConflictException {
  return new ConflictException({
    status: "conflict",
    code: "WEBHOOK_UNAVAILABLE",
    message,
  });
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined) throw invalid(`${name} contains unsupported field ${extra}`);
  const absent = required.find((key) => !(key in value));
  if (absent !== undefined) throw invalid(`${name}.${absent} is required`);
}

function parseEventTypes(value: unknown): readonly NotificationEventType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid("eventTypes must be a non-empty array");
  }
  const entries = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(entry)
    ) {
      throw invalid("eventTypes contains an unsupported notification type");
    }
    return entry as NotificationEventType;
  });
  if (new Set(entries).size !== entries.length) {
    throw invalid("eventTypes must not contain duplicates");
  }
  return Object.freeze(NOTIFICATION_EVENT_TYPES.filter((entry) => entries.includes(entry)));
}

function parseUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw invalid(`${name} must be a UUID`);
  return value;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped !== undefined && isPrivateIpv4(mapped);
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw invalid("endpoint must be an HTTPS URL no longer than 2048 characters");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw invalid("endpoint must be a valid HTTPS URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw invalid("endpoint must use HTTPS without credentials or a fragment");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (isIP(hostname) !== 0 && isPrivateAddress(hostname))
  ) {
    throw invalid("endpoint must use a public host");
  }
  return endpoint.href;
}

function parseRegister(value: unknown): RegisterInput {
  const input = record(value, "request");
  exactKeys(input, ["endpoint", "eventTypes"], [], "request");
  return {
    endpoint: parseEndpoint(input["endpoint"]),
    eventTypes: parseEventTypes(input["eventTypes"]),
  };
}

function parseUpdate(value: unknown): UpdateInput {
  const input = record(value, "request");
  exactKeys(input, [], ["enabled", "eventTypes"], "request");
  if (!("enabled" in input) && !("eventTypes" in input)) {
    throw invalid("request must change enabled or eventTypes");
  }
  if ("enabled" in input && typeof input["enabled"] !== "boolean") {
    throw invalid("enabled must be boolean");
  }
  return {
    ...(typeof input["enabled"] === "boolean" ? { enabled: input["enabled"] } : {}),
    ...(input["eventTypes"] === undefined
      ? {}
      : { eventTypes: parseEventTypes(input["eventTypes"]) }),
  };
}

function storedEventTypes(value: unknown): readonly NotificationEventType[] {
  if (!Array.isArray(value)) throw new Error("stored webhook event types are malformed");
  const entries = value as readonly unknown[];
  if (
    entries.length === 0 ||
    new Set(entries).size !== entries.length ||
    entries.some(
      (entry) =>
        typeof entry !== "string" ||
        !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(entry),
    )
  ) {
    throw new Error("stored webhook event types are malformed");
  }
  return Object.freeze(
    NOTIFICATION_EVENT_TYPES.filter((entry) => (entries as readonly string[]).includes(entry)),
  );
}

function credentialAad(network: string, ownerLockHash: string, subscriptionId: string): Buffer {
  return Buffer.from(
    `webhook-subscription:v1:${network}:${ownerLockHash}:${subscriptionId}`,
    "utf8",
  );
}

function decodeCredential(
  ciphertext: string,
  key: Buffer,
  associatedData: Buffer,
): WebhookCredential {
  const decoded = JSON.parse(decryptSecret(ciphertext, key, associatedData)) as unknown;
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("stored webhook credential is malformed");
  }
  const endpoint = Reflect.get(decoded, "endpoint");
  const secret = Reflect.get(decoded, "secret");
  if (
    Object.keys(decoded).toSorted().join(",") !== "endpoint,secret" ||
    typeof endpoint !== "string" ||
    typeof secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)
  ) {
    throw new Error("stored webhook credential is malformed");
  }
  try {
    if (parseEndpoint(endpoint) !== endpoint) {
      throw new Error("stored webhook credential is malformed");
    }
  } catch {
    throw new Error("stored webhook credential is malformed");
  }
  return Object.freeze({ endpoint, secret });
}

function deliveryIdempotencyKey(
  network: string,
  subscriptionId: string,
  eventId: bigint,
  replayNumber: number,
): string {
  return createHash("sha256")
    .update(
      `automata-webhook:v1:${network}:${subscriptionId}:${eventId.toString()}:${replayNumber}`,
    )
    .digest("hex");
}

export function signWebhookRequest(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhookRequest(secret, timestamp, body), "utf8");
  const received = Buffer.from(signature, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function excerpt(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= MAX_RESPONSE_EXCERPT_BYTES) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = MAX_RESPONSE_EXCERPT_BYTES + 1 - length;
      chunks.push(result.value.slice(0, remaining));
      length += Math.min(result.value.length, remaining);
      if (length > MAX_RESPONSE_EXCERPT_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const combined = new Uint8Array(Math.min(length, MAX_RESPONSE_EXCERPT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const selected = chunk.slice(0, combined.length - offset);
    combined.set(selected, offset);
    offset += selected.length;
    if (offset === combined.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function deliveryResponse(row: DeliveryRow): WebhookDeliveryResponse {
  if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(row.notificationType)) {
    throw new Error("stored webhook notification type is malformed");
  }
  if (
    !(["pending", "retry_scheduled", "delivered", "failed"] as const).includes(row.status as never)
  ) {
    throw new Error("stored webhook delivery status is malformed");
  }
  return Object.freeze({
    attemptNumber: row.attemptNumber,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    eventId: row.eventId.toString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    notificationType: row.notificationType as NotificationEventType,
    replayNumber: row.replayNumber,
    responseCode: row.responseCode,
    responseExcerpt: row.responseExcerpt,
    status: row.status as WebhookDeliveryResponse["status"],
  });
}

export class WebhookService {
  readonly #auth: AuthService;
  readonly #database: AutomataDatabase;
  readonly #encryptionKey: Buffer;
  readonly #fetch: typeof globalThis.fetch;
  readonly #network: string;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #randomIv: () => Buffer;
  readonly #randomUuid: () => string;
  readonly #resolveHostname: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly #timeoutMs: number;
  readonly #metrics: Pick<AutomataMetrics, "webhookDeliveriesTotal"> | undefined;

  constructor(
    database: AutomataDatabase,
    auth: AuthService,
    environment: Pick<AutomataEnvironment, "CKB_NETWORK" | "WEBHOOK_ENCRYPTION_KEY">,
    options: WebhookServiceOptions = {},
  ) {
    this.#auth = auth;
    this.#database = database;
    this.#encryptionKey = decodeEncryptionKey(environment.WEBHOOK_ENCRYPTION_KEY);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#metrics = options.metrics;
    this.#network = environment.CKB_NETWORK;
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#randomIv = options.randomIv ?? (() => randomBytes(12));
    this.#randomUuid = options.randomUuid ?? randomUUID;
    this.#resolveHostname =
      options.resolveHostname ??
      (async (hostname) => lookup(hostname, { all: true, verbatim: true }));
    const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      throw new RangeError("webhook timeout must be between 1 and 30000 milliseconds");
    }
    this.#timeoutMs = timeoutMs;
  }

  async register(
    authorization: string | undefined,
    value: unknown,
  ): Promise<WebhookRegistrationResponse> {
    const session = await this.#auth.authenticate(authorization);
    const input = parseRegister(value);
    await this.#assertPublicDestination(input.endpoint);
    const id = this.#randomUuid();
    const secret = this.#randomBytes(32).toString("base64url");
    const now = this.#now();
    const destinationCiphertext = encryptSecret(
      JSON.stringify({ endpoint: input.endpoint, secret }),
      this.#encryptionKey,
      credentialAad(this.#network, session.ownerLockHash, id),
      this.#randomIv,
    );
    const [row] = await this.#database
      .insert(notificationSubscriptions)
      .values({
        id,
        networkId: this.#network,
        ownerLockHash: session.ownerLockHash,
        channel: "webhook",
        destinationCiphertext,
        eventTypes: input.eventTypes,
        enabled: true,
        secretVersion: 1,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (row === undefined) throw new Error("webhook registration did not return its record");
    return Object.freeze({ ...this.#subscriptionResponse(row), secret });
  }

  async list(
    authorization: string | undefined,
  ): Promise<{ readonly items: readonly WebhookSubscriptionResponse[] }> {
    const session = await this.#auth.authenticate(authorization);
    const rows = await this.#database
      .select()
      .from(notificationSubscriptions)
      .where(
        and(
          eq(notificationSubscriptions.networkId, this.#network),
          eq(notificationSubscriptions.ownerLockHash, session.ownerLockHash),
          eq(notificationSubscriptions.channel, "webhook"),
        ),
      )
      .orderBy(desc(notificationSubscriptions.createdAt), desc(notificationSubscriptions.id));
    return Object.freeze({
      items: Object.freeze(rows.map((row) => this.#subscriptionResponse(row))),
    });
  }

  async update(
    authorization: string | undefined,
    subscriptionIdInput: string,
    value: unknown,
  ): Promise<WebhookSubscriptionResponse> {
    const session = await this.#auth.authenticate(authorization);
    const subscriptionId = parseUuid(subscriptionIdInput, "subscriptionId");
    const input = parseUpdate(value);
    const now = this.#now();
    const row = await this.#database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(notificationSubscriptions)
        .set({
          ...(input.enabled === undefined
            ? {}
            : { enabled: input.enabled, disabledAt: input.enabled ? null : now }),
          ...(input.eventTypes === undefined ? {} : { eventTypes: input.eventTypes }),
          updatedAt: now,
        })
        .where(
          and(
            eq(notificationSubscriptions.id, subscriptionId),
            eq(notificationSubscriptions.networkId, this.#network),
            eq(notificationSubscriptions.ownerLockHash, session.ownerLockHash),
            eq(notificationSubscriptions.channel, "webhook"),
          ),
        )
        .returning();
      if (updated === undefined) throw missing();
      if (input.enabled === false) {
        await transaction
          .update(webhookDeliveries)
          .set({
            errorCode: "WEBHOOK_DISABLED",
            finishedAt: now,
            nextAttemptAt: null,
            status: "failed",
          })
          .where(
            and(
              eq(webhookDeliveries.subscriptionId, subscriptionId),
              eq(webhookDeliveries.status, "retry_scheduled"),
            ),
          );
      }
      return updated;
    });
    return this.#subscriptionResponse(row);
  }

  async rotateSecret(
    authorization: string | undefined,
    subscriptionIdInput: string,
  ): Promise<{
    readonly id: string;
    readonly rotatedAt: string;
    readonly secret: string;
    readonly secretVersion: number;
  }> {
    const session = await this.#auth.authenticate(authorization);
    const subscriptionId = parseUuid(subscriptionIdInput, "subscriptionId");
    const now = this.#now();
    const secret = this.#randomBytes(32).toString("base64url");
    const row = await this.#database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(notificationSubscriptions)
        .where(
          and(
            eq(notificationSubscriptions.id, subscriptionId),
            eq(notificationSubscriptions.networkId, this.#network),
            eq(notificationSubscriptions.ownerLockHash, session.ownerLockHash),
            eq(notificationSubscriptions.channel, "webhook"),
          ),
        )
        .for("update")
        .limit(1);
      if (existing === undefined) throw missing();
      const credential = this.#credential(existing);
      const [updated] = await transaction
        .update(notificationSubscriptions)
        .set({
          destinationCiphertext: encryptSecret(
            JSON.stringify({ endpoint: credential.endpoint, secret }),
            this.#encryptionKey,
            credentialAad(this.#network, session.ownerLockHash, subscriptionId),
            this.#randomIv,
          ),
          secretVersion: existing.secretVersion + 1,
          updatedAt: now,
        })
        .where(eq(notificationSubscriptions.id, subscriptionId))
        .returning();
      if (updated === undefined) throw new Error("webhook secret rotation lost its record");
      return updated;
    });
    return Object.freeze({
      id: row.id,
      rotatedAt: now.toISOString(),
      secret,
      secretVersion: row.secretVersion,
    });
  }

  async history(
    authorization: string | undefined,
    subscriptionIdInput: string,
    query: Readonly<Record<string, unknown>>,
  ): Promise<WebhookDeliveryRun> {
    const session = await this.#auth.authenticate(authorization);
    const subscriptionId = parseUuid(subscriptionIdInput, "subscriptionId");
    const limit = this.#historyLimit(query);
    await this.#ownedSubscription(session.ownerLockHash, subscriptionId);
    const rows = await this.#database
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(limit);
    return Object.freeze({
      items: Object.freeze(rows.map(deliveryResponse)),
      subscriptionId,
    });
  }

  async deliver(
    subscriptionIdInput: string,
    eventId: bigint,
    notificationType: NotificationEventType,
  ): Promise<WebhookDeliveryResponse> {
    const subscriptionId = parseUuid(subscriptionIdInput, "subscriptionId");
    if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(notificationType)) {
      throw invalid("notificationType is unsupported");
    }
    return this.#attempt(subscriptionId, eventId, notificationType, 0, 1);
  }

  async retryDue(limit = 25): Promise<readonly WebhookDeliveryResponse[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("retry limit must be between 1 and 100");
    }
    const now = this.#now();
    const staleBefore = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS);
    await this.#database
      .update(webhookDeliveries)
      .set({
        errorCode: "WEBHOOK_PROCESS_INTERRUPTED",
        finishedAt: now,
        nextAttemptAt: now,
        status: "retry_scheduled",
      })
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          lt(webhookDeliveries.attemptNumber, WEBHOOK_MAX_ATTEMPTS),
          lte(webhookDeliveries.createdAt, staleBefore),
        ),
      );
    await this.#database
      .update(webhookDeliveries)
      .set({
        errorCode: "WEBHOOK_PROCESS_INTERRUPTED",
        finishedAt: now,
        nextAttemptAt: null,
        status: "failed",
      })
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.attemptNumber, WEBHOOK_MAX_ATTEMPTS),
          lte(webhookDeliveries.createdAt, staleBefore),
        ),
      );
    const due = await this.#database
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, "retry_scheduled"),
          lte(webhookDeliveries.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
      .limit(limit);
    const results: WebhookDeliveryResponse[] = [];
    for (const row of due) {
      try {
        results.push(
          await this.#attempt(
            row.subscriptionId,
            row.eventId,
            row.notificationType as NotificationEventType,
            row.replayNumber,
            row.attemptNumber + 1,
          ),
        );
      } catch (error) {
        if (error instanceof ConflictException) continue;
        throw error;
      }
    }
    return Object.freeze(results);
  }

  async replay(
    authorization: string | undefined,
    subscriptionIdInput: string,
    deliveryIdInput: string,
  ): Promise<WebhookDeliveryResponse> {
    const session = await this.#auth.authenticate(authorization);
    const subscriptionId = parseUuid(subscriptionIdInput, "subscriptionId");
    const deliveryId = parseUuid(deliveryIdInput, "deliveryId");
    const replay = await this.#database.transaction(async (transaction) => {
      const [subscription] = await transaction
        .select()
        .from(notificationSubscriptions)
        .where(
          and(
            eq(notificationSubscriptions.id, subscriptionId),
            eq(notificationSubscriptions.networkId, this.#network),
            eq(notificationSubscriptions.ownerLockHash, session.ownerLockHash),
            eq(notificationSubscriptions.channel, "webhook"),
          ),
        )
        .for("update")
        .limit(1);
      if (subscription === undefined) throw missing();
      if (!subscription.enabled) throw unavailable("webhook subscription is disabled");
      const [source] = await transaction
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.id, deliveryId),
            eq(webhookDeliveries.subscriptionId, subscriptionId),
          ),
        )
        .limit(1);
      if (source === undefined) throw missing();
      await transaction
        .update(notificationSubscriptions)
        .set({ nextReplayNumber: subscription.nextReplayNumber + 1, updatedAt: this.#now() })
        .where(eq(notificationSubscriptions.id, subscription.id));
      return {
        eventId: source.eventId,
        notificationType: source.notificationType as NotificationEventType,
        replayNumber: subscription.nextReplayNumber,
      };
    });
    return this.#attempt(
      subscriptionId,
      replay.eventId,
      replay.notificationType,
      replay.replayNumber,
      1,
    );
  }

  async #attempt(
    subscriptionId: string,
    eventId: bigint,
    notificationType: NotificationEventType,
    replayNumber: number,
    attemptNumber: number,
  ): Promise<WebhookDeliveryResponse> {
    if (attemptNumber < 1 || attemptNumber > WEBHOOK_MAX_ATTEMPTS) {
      throw new RangeError("webhook attempt is outside the bounded retry policy");
    }
    const { event, subscription } = await this.#deliveryContext(subscriptionId, eventId);
    if (!subscription.enabled) throw unavailable("webhook subscription is disabled");
    if (!storedEventTypes(subscription.eventTypes).includes(notificationType)) {
      throw unavailable("webhook subscription does not select this notification type");
    }
    const credential = this.#credential(subscription);
    await this.#assertPublicDestination(credential.endpoint);
    const now = this.#now();
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const idempotencyKey = deliveryIdempotencyKey(
      this.#network,
      subscription.id,
      event.id,
      replayNumber,
    );
    const body = JSON.stringify({
      apiVersion: "2026-09-23",
      delivery: { attempt: attemptNumber, replay: replayNumber },
      event: {
        id: event.id.toString(),
        jobId: event.jobId,
        occurredAt: event.occurredAt.toISOString(),
        recordedAt: event.createdAt.toISOString(),
        source: event.source,
        type: event.eventType,
        details: event.payload,
      },
      idempotencyKey,
      kind: "notification",
      network: this.#network,
      notificationType,
      proof: null,
      sentAt: now.toISOString(),
    });
    const requestSignature = signWebhookRequest(credential.secret, timestamp, body);
    const id = this.#randomUuid();
    const [claim] = await this.#database
      .insert(webhookDeliveries)
      .values({
        id,
        subscriptionId,
        eventId: event.id,
        attemptNumber,
        replayNumber,
        notificationType,
        idempotencyKey,
        requestSignature,
        status: "pending",
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (claim === undefined) {
      const [existing] = await this.#database
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.subscriptionId, subscriptionId),
            eq(webhookDeliveries.eventId, event.id),
            eq(webhookDeliveries.replayNumber, replayNumber),
            eq(webhookDeliveries.attemptNumber, attemptNumber),
          ),
        )
        .limit(1);
      if (existing === undefined) throw new Error("webhook attempt conflict lost its record");
      return deliveryResponse(existing);
    }

    let responseCode: number | null = null;
    let responseExcerpt: string | null = null;
    let errorCode: string | null = null;
    let retryable = false;
    try {
      const response = await this.#fetch(credential.endpoint, {
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": "ckb-automata-webhook/1",
          "x-automata-delivery": idempotencyKey,
          "x-automata-event": notificationType,
          "x-automata-event-id": event.id.toString(),
          "x-automata-signature": requestSignature,
          "x-automata-timestamp": timestamp,
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      responseCode = response.status;
      responseExcerpt = await excerpt(response);
      if (!response.ok) {
        retryable = retryableStatus(response.status);
        errorCode = retryable ? "WEBHOOK_TRANSIENT_HTTP" : "WEBHOOK_PERMANENT_HTTP";
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      retryable = true;
      errorCode =
        name === "AbortError" || name === "TimeoutError"
          ? "WEBHOOK_TIMEOUT"
          : "WEBHOOK_NETWORK_ERROR";
    }
    const finishedAt = this.#now();
    const delivered = responseCode !== null && responseCode >= 200 && responseCode <= 299;
    const retryScheduled = !delivered && retryable && attemptNumber < WEBHOOK_MAX_ATTEMPTS;
    const nextAttemptAt = retryScheduled
      ? new Date(finishedAt.getTime() + (WEBHOOK_RETRY_DELAYS_MS[attemptNumber - 1] ?? 0))
      : null;
    const [completed] = await this.#database
      .update(webhookDeliveries)
      .set({
        deliveredAt: delivered ? finishedAt : null,
        errorCode: delivered ? null : errorCode,
        finishedAt,
        nextAttemptAt,
        responseCode,
        responseExcerpt,
        status: delivered ? "delivered" : retryScheduled ? "retry_scheduled" : "failed",
      })
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending")))
      .returning();
    if (completed === undefined) throw new Error("webhook attempt completion lost its claim");
    this.#metrics?.webhookDeliveriesTotal.inc({ outcome: completed.status });
    return deliveryResponse(completed);
  }

  async #deliveryContext(
    subscriptionId: string,
    eventId: bigint,
  ): Promise<{ readonly event: EventRow; readonly subscription: SubscriptionRow }> {
    const [subscription] = await this.#database
      .select()
      .from(notificationSubscriptions)
      .where(
        and(
          eq(notificationSubscriptions.id, subscriptionId),
          eq(notificationSubscriptions.networkId, this.#network),
          eq(notificationSubscriptions.channel, "webhook"),
        ),
      )
      .limit(1);
    if (subscription === undefined) throw missing();
    const [event] = await this.#database
      .select()
      .from(jobEvents)
      .where(and(eq(jobEvents.id, eventId), eq(jobEvents.networkId, this.#network)))
      .limit(1);
    if (event === undefined) throw missing();
    const [job] = await this.#database
      .select({ ownerLockHash: jobs.ownerLockHash })
      .from(jobs)
      .where(and(eq(jobs.networkId, this.#network), eq(jobs.jobId, event.jobId)))
      .limit(1);
    if (job === undefined || job.ownerLockHash !== subscription.ownerLockHash) throw missing();
    return { event, subscription };
  }

  async #ownedSubscription(
    ownerLockHash: string,
    subscriptionId: string,
  ): Promise<SubscriptionRow> {
    const [row] = await this.#database
      .select()
      .from(notificationSubscriptions)
      .where(
        and(
          eq(notificationSubscriptions.id, subscriptionId),
          eq(notificationSubscriptions.networkId, this.#network),
          eq(notificationSubscriptions.ownerLockHash, ownerLockHash),
          eq(notificationSubscriptions.channel, "webhook"),
        ),
      )
      .limit(1);
    if (row === undefined) throw missing();
    return row;
  }

  #credential(row: SubscriptionRow): WebhookCredential {
    return decodeCredential(
      row.destinationCiphertext,
      this.#encryptionKey,
      credentialAad(this.#network, row.ownerLockHash, row.id),
    );
  }

  #subscriptionResponse(row: SubscriptionRow): WebhookSubscriptionResponse {
    return Object.freeze({
      createdAt: row.createdAt.toISOString(),
      enabled: row.enabled,
      endpoint: this.#credential(row).endpoint,
      eventTypes: storedEventTypes(row.eventTypes),
      id: row.id,
      secretVersion: row.secretVersion,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async #assertPublicDestination(endpoint: string): Promise<void> {
    const hostname = new URL(endpoint).hostname;
    if (isIP(hostname) !== 0) {
      if (isPrivateAddress(hostname)) throw invalid("endpoint must use a public host");
      return;
    }
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolveHostname(hostname);
    } catch {
      throw invalid("endpoint host could not be resolved");
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw invalid("endpoint must resolve only to public addresses");
    }
  }

  #historyLimit(query: Readonly<Record<string, unknown>>): number {
    const unknown = Object.keys(query).find((key) => key !== "limit");
    if (unknown !== undefined) throw invalid(`unsupported query parameter: ${unknown}`);
    const value = query["limit"];
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      throw invalid("limit must be provided once");
    }
    const text = value === undefined ? String(DEFAULT_HISTORY_LIMIT) : String(value);
    const limit = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || limit > MAX_HISTORY_LIMIT) {
      throw invalid(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`);
    }
    return limit;
  }
}

export class WebhookController {
  readonly #webhooks: WebhookService;

  constructor(webhooks: WebhookService) {
    this.#webhooks = webhooks;
  }

  register(authorization: string | undefined, body: unknown): Promise<WebhookRegistrationResponse> {
    return this.#webhooks.register(authorization, body);
  }

  list(authorization: string | undefined) {
    return this.#webhooks.list(authorization);
  }

  update(authorization: string | undefined, subscriptionId: string, body: unknown) {
    return this.#webhooks.update(authorization, subscriptionId, body);
  }

  rotate(authorization: string | undefined, subscriptionId: string) {
    return this.#webhooks.rotateSecret(authorization, subscriptionId);
  }

  history(
    authorization: string | undefined,
    subscriptionId: string,
    query: Readonly<Record<string, unknown>>,
  ) {
    return this.#webhooks.history(authorization, subscriptionId, query);
  }

  replay(authorization: string | undefined, subscriptionId: string, deliveryId: string) {
    return this.#webhooks.replay(authorization, subscriptionId, deliveryId);
  }
}

const eventTypesSchema = {
  type: "array",
  minItems: 1,
  maxItems: NOTIFICATION_EVENT_TYPES.length,
  uniqueItems: true,
  items: { type: "string", enum: [...NOTIFICATION_EVENT_TYPES] },
};
const subscriptionSchema = {
  type: "object",
  required: ["createdAt", "enabled", "endpoint", "eventTypes", "id", "secretVersion", "updatedAt"],
  properties: {
    createdAt: { type: "string", format: "date-time" },
    enabled: { type: "boolean" },
    endpoint: { type: "string", format: "uri" },
    eventTypes: eventTypesSchema,
    id: { type: "string", format: "uuid" },
    secretVersion: { type: "integer", minimum: 1 },
    updatedAt: { type: "string", format: "date-time" },
  },
};
const deliverySchema = {
  type: "object",
  required: [
    "attemptNumber",
    "createdAt",
    "deliveredAt",
    "errorCode",
    "eventId",
    "finishedAt",
    "id",
    "idempotencyKey",
    "nextAttemptAt",
    "notificationType",
    "replayNumber",
    "responseCode",
    "responseExcerpt",
    "status",
  ],
  properties: {
    attemptNumber: { type: "integer", minimum: 1, maximum: WEBHOOK_MAX_ATTEMPTS },
    createdAt: { type: "string", format: "date-time" },
    deliveredAt: { type: "string", format: "date-time", nullable: true },
    errorCode: { type: "string", nullable: true },
    eventId: { type: "string", pattern: "^[1-9][0-9]*$" },
    finishedAt: { type: "string", format: "date-time", nullable: true },
    id: { type: "string", format: "uuid" },
    idempotencyKey: { type: "string", pattern: "^[0-9a-f]{64}$" },
    nextAttemptAt: { type: "string", format: "date-time", nullable: true },
    notificationType: { type: "string", enum: [...NOTIFICATION_EVENT_TYPES] },
    replayNumber: { type: "integer", minimum: 0 },
    responseCode: { type: "integer", minimum: 100, maximum: 599, nullable: true },
    responseExcerpt: { type: "string", nullable: true },
    status: { type: "string", enum: ["pending", "retry_scheduled", "delivered", "failed"] },
  },
};

Inject(WebhookService)(WebhookController, undefined, 0);
Controller("webhooks")(WebhookController);
ApiTags("webhooks")(WebhookController);

Post()(
  WebhookController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "register")!,
);
Headers("authorization")(WebhookController.prototype, "register", 0);
Body()(WebhookController.prototype, "register", 1);
Get()(
  WebhookController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "list")!,
);
Headers("authorization")(WebhookController.prototype, "list", 0);
Patch(":subscriptionId")(
  WebhookController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "update")!,
);
Headers("authorization")(WebhookController.prototype, "update", 0);
Param("subscriptionId")(WebhookController.prototype, "update", 1);
Body()(WebhookController.prototype, "update", 2);
Post(":subscriptionId/rotate-secret")(
  WebhookController.prototype,
  "rotate",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "rotate")!,
);
Headers("authorization")(WebhookController.prototype, "rotate", 0);
Param("subscriptionId")(WebhookController.prototype, "rotate", 1);
Get(":subscriptionId/deliveries")(
  WebhookController.prototype,
  "history",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "history")!,
);
Headers("authorization")(WebhookController.prototype, "history", 0);
Param("subscriptionId")(WebhookController.prototype, "history", 1);
Query()(WebhookController.prototype, "history", 2);
Post(":subscriptionId/deliveries/:deliveryId/replay")(
  WebhookController.prototype,
  "replay",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "replay")!,
);
Headers("authorization")(WebhookController.prototype, "replay", 0);
Param("subscriptionId")(WebhookController.prototype, "replay", 1);
Param("deliveryId")(WebhookController.prototype, "replay", 2);

for (const method of ["register", "list", "update", "rotate", "history", "replay"] as const) {
  ApiBearerAuth()(
    WebhookController.prototype,
    method,
    Object.getOwnPropertyDescriptor(WebhookController.prototype, method)!,
  );
  ApiUnauthorizedResponse({ description: "A valid off-chain settings session is required" })(
    WebhookController.prototype,
    method,
    Object.getOwnPropertyDescriptor(WebhookController.prototype, method)!,
  );
}
for (const method of ["update", "rotate", "history", "replay"] as const) {
  ApiParam({ name: "subscriptionId", format: "uuid", type: String })(
    WebhookController.prototype,
    method,
    Object.getOwnPropertyDescriptor(WebhookController.prototype, method)!,
  );
  ApiNotFoundResponse({ description: "The owner-scoped webhook resource was not found" })(
    WebhookController.prototype,
    method,
    Object.getOwnPropertyDescriptor(WebhookController.prototype, method)!,
  );
}

ApiOperation({ summary: "Register an owner-scoped signed webhook" })(
  WebhookController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "register")!,
);
ApiBody({
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["endpoint", "eventTypes"],
    properties: { endpoint: { type: "string", format: "uri" }, eventTypes: eventTypesSchema },
  },
})(
  WebhookController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "register")!,
);
ApiCreatedResponse({
  schema: {
    ...subscriptionSchema,
    required: [...subscriptionSchema.required, "secret"],
    properties: {
      ...subscriptionSchema.properties,
      secret: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "Returned once" },
    },
  },
})(
  WebhookController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "register")!,
);
ApiBadRequestResponse({ description: "Malformed or unsafe webhook registration" })(
  WebhookController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "register")!,
);

ApiOperation({ summary: "List owner-scoped webhook registrations" })(
  WebhookController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["items"],
    properties: { items: { type: "array", items: subscriptionSchema } },
  },
})(
  WebhookController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "list")!,
);

ApiOperation({ summary: "Update webhook event selection or enablement" })(
  WebhookController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "update")!,
);
ApiBody({
  schema: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: { enabled: { type: "boolean" }, eventTypes: eventTypesSchema },
  },
})(
  WebhookController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "update")!,
);
ApiOkResponse({ schema: subscriptionSchema })(
  WebhookController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "update")!,
);

ApiOperation({ summary: "Rotate a webhook signing secret" })(
  WebhookController.prototype,
  "rotate",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "rotate")!,
);
ApiCreatedResponse({
  schema: {
    type: "object",
    required: ["id", "rotatedAt", "secret", "secretVersion"],
    properties: {
      id: { type: "string", format: "uuid" },
      rotatedAt: { type: "string", format: "date-time" },
      secret: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "Returned once" },
      secretVersion: { type: "integer", minimum: 2 },
    },
  },
})(
  WebhookController.prototype,
  "rotate",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "rotate")!,
);

ApiOperation({ summary: "Read owner-scoped webhook delivery history" })(
  WebhookController.prototype,
  "history",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "history")!,
);
ApiQuery({ name: "limit", required: false, type: Number, minimum: 1, maximum: MAX_HISTORY_LIMIT })(
  WebhookController.prototype,
  "history",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "history")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["items", "subscriptionId"],
    properties: {
      items: { type: "array", items: deliverySchema },
      subscriptionId: { type: "string", format: "uuid" },
    },
  },
})(
  WebhookController.prototype,
  "history",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "history")!,
);

ApiOperation({ summary: "Replay a webhook event as a new idempotent delivery run" })(
  WebhookController.prototype,
  "replay",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "replay")!,
);
ApiParam({ name: "deliveryId", format: "uuid", type: String })(
  WebhookController.prototype,
  "replay",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "replay")!,
);
ApiCreatedResponse({ schema: deliverySchema })(
  WebhookController.prototype,
  "replay",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "replay")!,
);
ApiConflictResponse({ description: "The webhook is disabled or does not select the event" })(
  WebhookController.prototype,
  "replay",
  Object.getOwnPropertyDescriptor(WebhookController.prototype, "replay")!,
);
