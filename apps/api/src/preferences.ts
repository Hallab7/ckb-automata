import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { BadRequestException, Body, Controller, Get, Headers, Inject, Put } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";

import type { AutomataEnvironment } from "@ckb-automata/config";

import { AuthService } from "./auth.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { notificationPreferences } from "./database/schema.ts";

export const NOTIFICATION_EVENT_TYPES = [
  "ready",
  "submitted",
  "confirmed",
  "failed",
  "budget_low",
  "cancelled",
  "recovery_required",
] as const;
export const NOTIFICATION_CHANNELS = ["browser", "email"] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

interface ChannelInput {
  readonly enabled: boolean;
  readonly eventTypes: readonly NotificationEventType[];
}

interface PreferencesInput {
  readonly browser: ChannelInput;
  readonly email: ChannelInput & { readonly address?: string | null };
}

export interface NotificationPreferencesResponse {
  readonly channels: {
    readonly browser: ChannelInput;
    readonly email: ChannelInput & { readonly address: string | null };
  };
  readonly network: string;
  readonly ownerLockHash: string;
}

export interface NotificationPreferencesOptions {
  readonly now?: () => Date;
  readonly randomIv?: () => Buffer;
  readonly randomUuid?: () => string;
}

type PreferenceRow = typeof notificationPreferences.$inferSelect;

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_NOTIFICATION_PREFERENCES",
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
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined) throw invalid(`${name} contains unsupported field ${extra}`);
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) throw invalid(`${name}.${missing} is required`);
}

function parseEvents(value: unknown, name: string): readonly NotificationEventType[] {
  if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
  const events = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(entry)
    ) {
      throw invalid(`${name} contains an unsupported event type`);
    }
    return entry as NotificationEventType;
  });
  if (new Set(events).size !== events.length) throw invalid(`${name} must not contain duplicates`);
  return Object.freeze(NOTIFICATION_EVENT_TYPES.filter((event) => events.includes(event)));
}

function parseChannel(value: unknown, name: string, allowAddress: boolean): ChannelInput {
  const input = record(value, name);
  exactKeys(input, ["enabled", "eventTypes"], allowAddress ? ["address"] : [], name);
  if (typeof input["enabled"] !== "boolean") throw invalid(`${name}.enabled must be boolean`);
  const eventTypes = parseEvents(input["eventTypes"], `${name}.eventTypes`);
  if (input["enabled"] && eventTypes.length === 0) {
    throw invalid(`${name}.eventTypes must select at least one event when enabled`);
  }
  return { enabled: input["enabled"], eventTypes };
}

function parseEmail(value: unknown): PreferencesInput["email"] {
  const input = record(value, "email");
  const channel = parseChannel(input, "email", true);
  if (!("address" in input)) return channel;
  if (input["address"] === null) return { ...channel, address: null };
  if (typeof input["address"] !== "string") throw invalid("email.address must be a string or null");
  const address = input["address"].trim().toLowerCase();
  if (
    address.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      address,
    )
  ) {
    throw invalid("email.address is malformed");
  }
  return { ...channel, address };
}

function parseInput(value: unknown): PreferencesInput {
  const input = record(value, "request");
  exactKeys(input, ["browser", "email"], [], "request");
  return {
    browser: parseChannel(input["browser"], "browser", false),
    email: parseEmail(input["email"]),
  };
}

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("WEBHOOK_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

function aad(network: string, ownerLockHash: string): Buffer {
  return Buffer.from(`notification-email:v1:${network}:${ownerLockHash}`, "utf8");
}

function encryptEmail(
  address: string,
  key: Buffer,
  associatedData: Buffer,
  randomIv: () => Buffer,
): string {
  const iv = randomIv();
  if (iv.length !== 12) throw new Error("notification IV provider must return 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(address, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function decryptEmail(value: string, key: Buffer, associatedData: Buffer): string {
  const [version, ivValue, ciphertextValue, tagValue, extra] = value.split(".");
  if (
    version !== "v1" ||
    ivValue === undefined ||
    ciphertextValue === undefined ||
    tagValue === undefined ||
    extra !== undefined
  ) {
    throw new Error("stored notification destination is malformed");
  }
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertextValue.length === 0) {
    throw new Error("stored notification destination is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function maskEmail(address: string): string {
  const separator = address.lastIndexOf("@");
  if (separator <= 0) throw new Error("stored notification email is malformed");
  return `${address[0]}***${address.slice(separator)}`;
}

function storedEvents(row: PreferenceRow | undefined): readonly NotificationEventType[] {
  if (row === undefined) return [];
  if (!Array.isArray(row.eventTypes)) {
    throw new Error("stored notification event types are malformed");
  }
  const events = row.eventTypes;
  if (
    events.some(
      (event) =>
        typeof event !== "string" ||
        !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(event),
    ) ||
    new Set(events).size !== events.length
  ) {
    throw new Error("stored notification event types are malformed");
  }
  return Object.freeze(
    NOTIFICATION_EVENT_TYPES.filter((event) => (events as readonly string[]).includes(event)),
  );
}

export class NotificationPreferencesService {
  readonly #auth: AuthService;
  readonly #database: AutomataDatabase;
  readonly #encryptionKey: Buffer;
  readonly #network: string;
  readonly #now: () => Date;
  readonly #randomIv: () => Buffer;
  readonly #randomUuid: () => string;

  constructor(
    database: AutomataDatabase,
    auth: AuthService,
    environment: Pick<AutomataEnvironment, "CKB_NETWORK" | "WEBHOOK_ENCRYPTION_KEY">,
    options: NotificationPreferencesOptions = {},
  ) {
    this.#auth = auth;
    this.#database = database;
    this.#encryptionKey = encryptionKey(environment.WEBHOOK_ENCRYPTION_KEY);
    this.#network = environment.CKB_NETWORK;
    this.#now = options.now ?? (() => new Date());
    this.#randomIv = options.randomIv ?? (() => randomBytes(12));
    this.#randomUuid = options.randomUuid ?? randomUUID;
  }

  async get(authorization: string | undefined): Promise<NotificationPreferencesResponse> {
    const session = await this.#auth.authenticate(authorization);
    const rows = await this.#database
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.networkId, this.#network),
          eq(notificationPreferences.ownerLockHash, session.ownerLockHash),
        ),
      );
    return this.#response(session.ownerLockHash, rows);
  }

  async update(
    authorization: string | undefined,
    value: unknown,
  ): Promise<NotificationPreferencesResponse> {
    const session = await this.#auth.authenticate(authorization);
    const input = parseInput(value);
    const now = this.#now();
    const rows = await this.#database.transaction(async (transaction) => {
      const existing = await transaction
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.networkId, this.#network),
            eq(notificationPreferences.ownerLockHash, session.ownerLockHash),
          ),
        )
        .for("update");
      const existingEmail = existing.find(({ channel }) => channel === "email");
      let destinationCiphertext = existingEmail?.destinationCiphertext ?? null;
      if (input.email.address === null) destinationCiphertext = null;
      if (typeof input.email.address === "string") {
        destinationCiphertext = encryptEmail(
          input.email.address,
          this.#encryptionKey,
          aad(this.#network, session.ownerLockHash),
          this.#randomIv,
        );
      }
      if (input.email.enabled && destinationCiphertext === null) {
        throw invalid("email.address is required before email notifications can be enabled");
      }

      for (const [channel, preference] of [
        ["browser", input.browser],
        ["email", input.email],
      ] as const) {
        await transaction
          .insert(notificationPreferences)
          .values({
            id: this.#randomUuid(),
            networkId: this.#network,
            ownerLockHash: session.ownerLockHash,
            channel,
            eventTypes: preference.eventTypes,
            destinationCiphertext: channel === "email" ? destinationCiphertext : null,
            enabled: preference.enabled,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              notificationPreferences.networkId,
              notificationPreferences.ownerLockHash,
              notificationPreferences.channel,
            ],
            set: {
              eventTypes: preference.eventTypes,
              destinationCiphertext: channel === "email" ? destinationCiphertext : null,
              enabled: preference.enabled,
              updatedAt: now,
            },
          });
      }
      return transaction
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.networkId, this.#network),
            eq(notificationPreferences.ownerLockHash, session.ownerLockHash),
          ),
        );
    });
    return this.#response(session.ownerLockHash, rows);
  }

  #response(
    ownerLockHash: string,
    rows: readonly PreferenceRow[],
  ): NotificationPreferencesResponse {
    const browser = rows.find(({ channel }) => channel === "browser");
    const email = rows.find(({ channel }) => channel === "email");
    const address =
      email?.destinationCiphertext === null || email?.destinationCiphertext === undefined
        ? null
        : maskEmail(
            decryptEmail(
              email.destinationCiphertext,
              this.#encryptionKey,
              aad(this.#network, ownerLockHash),
            ),
          );
    return Object.freeze({
      channels: Object.freeze({
        browser: Object.freeze({
          enabled: browser?.enabled ?? false,
          eventTypes: storedEvents(browser),
        }),
        email: Object.freeze({
          address,
          enabled: email?.enabled ?? false,
          eventTypes: storedEvents(email),
        }),
      }),
      network: this.#network,
      ownerLockHash,
    });
  }
}

export class NotificationPreferencesController {
  readonly #preferences: NotificationPreferencesService;

  constructor(preferences: NotificationPreferencesService) {
    this.#preferences = preferences;
  }

  get(authorization: string | undefined): Promise<NotificationPreferencesResponse> {
    return this.#preferences.get(authorization);
  }

  update(
    authorization: string | undefined,
    body: unknown,
  ): Promise<NotificationPreferencesResponse> {
    return this.#preferences.update(authorization, body);
  }
}

const eventTypesSchema = {
  type: "array",
  uniqueItems: true,
  maxItems: NOTIFICATION_EVENT_TYPES.length,
  items: { type: "string", enum: [...NOTIFICATION_EVENT_TYPES] },
};
const channelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "eventTypes"],
  properties: { enabled: { type: "boolean" }, eventTypes: eventTypesSchema },
};
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["browser", "email"],
  properties: {
    browser: channelSchema,
    email: {
      ...channelSchema,
      properties: {
        ...channelSchema.properties,
        address: { type: "string", format: "email", nullable: true },
      },
    },
  },
};
const responseSchema = {
  type: "object",
  required: ["channels", "network", "ownerLockHash"],
  properties: {
    channels: {
      type: "object",
      required: ["browser", "email"],
      properties: {
        browser: channelSchema,
        email: {
          ...channelSchema,
          required: [...channelSchema.required, "address"],
          properties: {
            ...channelSchema.properties,
            address: { type: "string", nullable: true, description: "Masked email address" },
          },
        },
      },
    },
    network: { type: "string", enum: ["ckb_dev", "ckb_testnet"] },
    ownerLockHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
  },
};

Inject(NotificationPreferencesService)(NotificationPreferencesController, undefined, 0);
Controller("preferences")(NotificationPreferencesController);
ApiTags("notification preferences")(NotificationPreferencesController);

Get()(
  NotificationPreferencesController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, "get")!,
);
Headers("authorization")(NotificationPreferencesController.prototype, "get", 0);
Put()(
  NotificationPreferencesController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, "update")!,
);
Headers("authorization")(NotificationPreferencesController.prototype, "update", 0);
Body()(NotificationPreferencesController.prototype, "update", 1);

for (const method of ["get", "update"] as const) {
  ApiBearerAuth()(
    NotificationPreferencesController.prototype,
    method,
    Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, method)!,
  );
  ApiOkResponse({ schema: responseSchema })(
    NotificationPreferencesController.prototype,
    method,
    Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, method)!,
  );
  ApiUnauthorizedResponse({ description: "A valid off-chain settings session is required" })(
    NotificationPreferencesController.prototype,
    method,
    Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, method)!,
  );
}
ApiOperation({ summary: "Read owner-scoped browser and email notification preferences" })(
  NotificationPreferencesController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, "get")!,
);
ApiOperation({ summary: "Replace owner-scoped browser and email notification preferences" })(
  NotificationPreferencesController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, "update")!,
);
ApiBody({ schema: inputSchema })(
  NotificationPreferencesController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, "update")!,
);
ApiBadRequestResponse({ description: "Malformed notification preferences" })(
  NotificationPreferencesController.prototype,
  "update",
  Object.getOwnPropertyDescriptor(NotificationPreferencesController.prototype, "update")!,
);
