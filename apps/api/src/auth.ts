import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Script, Signature, Signer, SignerSignType, hashCkbShort } from "@ckb-ccc/shell";
import { and, eq, gt, isNull } from "drizzle-orm";

import type { AutomataEnvironment } from "@ckb-automata/config";

import type { AutomataDatabase } from "./database/client.ts";
import { authChallenges, authSessions } from "./database/schema.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const COMPRESSED_PUBLIC_KEY_PATTERN = /^0x(?:02|03)[0-9a-f]{64}$/;
const RECOVERABLE_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const AUTH_SESSION_SCOPE = "off_chain_settings" as const;

interface ScriptInput {
  readonly args: string;
  readonly codeHash: string;
  readonly hashType: "data" | "data1" | "type";
}

interface ChallengeRequest {
  readonly ownerLockHash: string;
}

interface VerifyRequest {
  readonly challengeId: string;
  readonly nonce: string;
  readonly ownerLock: ScriptInput;
  readonly signature: {
    readonly identity: string;
    readonly signature: string;
    readonly signType: "CkbSecp256k1";
  };
}

export interface AuthChallengeMessageInput {
  readonly challengeId: string;
  readonly domain: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly network: string;
  readonly nonce: string;
  readonly ownerLockHash: string;
}

export interface AuthChallengeResponse {
  readonly challengeId: string;
  readonly domain: string;
  readonly expiresAt: string;
  readonly message: string;
  readonly network: string;
  readonly nonce: string;
}

export interface AuthSessionResponse {
  readonly expiresAt: string;
  readonly network: string;
  readonly ownerLockHash: string;
  readonly scope: readonly [typeof AUTH_SESSION_SCOPE];
  readonly sessionToken: string;
}

export interface AuthenticatedSession {
  readonly expiresAt: Date;
  readonly id: string;
  readonly network: string;
  readonly ownerLockHash: string;
  readonly scope: typeof AUTH_SESSION_SCOPE;
}

export interface AuthServiceOptions {
  readonly now?: () => Date;
  readonly randomNonce?: () => string;
  readonly randomSessionToken?: () => string;
  readonly randomUuid?: () => string;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_AUTH_REQUEST",
    message,
  });
}

function unauthorized(code: string): UnauthorizedException {
  return new UnauthorizedException({
    status: "unauthorized",
    code,
    message: "wallet authentication failed",
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
  keys: readonly string[],
  name: string,
) {
  const expected = new Set(keys);
  const extra = Object.keys(value).find((key) => !expected.has(key));
  if (extra !== undefined) throw invalid(`${name} contains unsupported field ${extra}`);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) throw invalid(`${name}.${missing} is required`);
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  return value;
}

function parseChallengeRequest(value: unknown): ChallengeRequest {
  const input = record(value, "request");
  exactKeys(input, ["ownerLockHash"], "request");
  const ownerLockHash = string(input["ownerLockHash"], "ownerLockHash");
  if (!HASH_PATTERN.test(ownerLockHash)) {
    throw invalid("ownerLockHash must be a lowercase 0x-prefixed 32-byte hash");
  }
  return { ownerLockHash };
}

function parseScript(value: unknown): ScriptInput {
  const input = record(value, "ownerLock");
  exactKeys(input, ["args", "codeHash", "hashType"], "ownerLock");
  const args = string(input["args"], "ownerLock.args");
  const codeHash = string(input["codeHash"], "ownerLock.codeHash");
  const hashType = string(input["hashType"], "ownerLock.hashType");
  if (!/^0x[0-9a-f]{40}$/.test(args)) {
    throw invalid("ownerLock.args must be a lowercase 20-byte secp256k1 hash");
  }
  if (!HASH_PATTERN.test(codeHash)) {
    throw invalid("ownerLock.codeHash must be a lowercase 0x-prefixed 32-byte hash");
  }
  if (hashType !== "data" && hashType !== "data1" && hashType !== "type") {
    throw invalid("ownerLock.hashType is unsupported");
  }
  return { args, codeHash, hashType };
}

function parseVerifyRequest(value: unknown): VerifyRequest {
  const input = record(value, "request");
  exactKeys(input, ["challengeId", "nonce", "ownerLock", "signature"], "request");
  const challengeId = string(input["challengeId"], "challengeId");
  const nonce = string(input["nonce"], "nonce");
  if (!UUID_PATTERN.test(challengeId)) throw invalid("challengeId must be a UUID");
  if (!OPAQUE_TOKEN_PATTERN.test(nonce)) throw invalid("nonce is malformed");
  const signatureInput = record(input["signature"], "signature");
  exactKeys(signatureInput, ["identity", "signature", "signType"], "signature");
  const identity = string(signatureInput["identity"], "signature.identity");
  const signature = string(signatureInput["signature"], "signature.signature");
  const signType = string(signatureInput["signType"], "signature.signType");
  if (!COMPRESSED_PUBLIC_KEY_PATTERN.test(identity)) {
    throw invalid("signature.identity must be a compressed secp256k1 public key");
  }
  if (!RECOVERABLE_SIGNATURE_PATTERN.test(signature)) {
    throw invalid("signature.signature must be a 65-byte recoverable signature");
  }
  if (signType !== SignerSignType.CkbSecp256k1) {
    throw invalid("signature.signType is unsupported for owner sessions");
  }
  return {
    challengeId,
    nonce,
    ownerLock: parseScript(input["ownerLock"]),
    signature: { identity, signature, signType },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function publicOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("PUBLIC_APP_ORIGIN must be an HTTP(S) origin without credentials");
  }
  return url.origin;
}

export function formatAuthChallengeMessage(input: AuthChallengeMessageInput): string {
  return [
    "CKB Automata Off-Chain Authentication v1",
    `Domain: ${input.domain}`,
    `Network: ${input.network}`,
    `Owner lock hash: ${input.ownerLockHash}`,
    `Challenge ID: ${input.challengeId}`,
    `Nonce: ${input.nonce}`,
    `Issued at: ${input.issuedAt.toISOString()}`,
    `Expires at: ${input.expiresAt.toISOString()}`,
    `Scope: ${AUTH_SESSION_SCOPE}`,
    "Notice: This signature cannot authorize a CKB transaction.",
  ].join("\n");
}

async function signatureMatchesOwner(
  message: string,
  ownerLock: ScriptInput,
  signature: VerifyRequest["signature"],
): Promise<boolean> {
  if (hashCkbShort(signature.identity) !== ownerLock.args) return false;
  try {
    return await Signer.verifyMessage(
      message,
      new Signature(signature.signature, signature.identity, SignerSignType.CkbSecp256k1),
    );
  } catch {
    return false;
  }
}

export class AuthService {
  readonly #database: AutomataDatabase;
  readonly #domain: string;
  readonly #network: string;
  readonly #now: () => Date;
  readonly #randomNonce: () => string;
  readonly #randomSessionToken: () => string;
  readonly #randomUuid: () => string;

  constructor(
    database: AutomataDatabase,
    environment: Pick<AutomataEnvironment, "CKB_NETWORK" | "PUBLIC_APP_ORIGIN">,
    options: AuthServiceOptions = {},
  ) {
    this.#database = database;
    this.#domain = publicOrigin(environment.PUBLIC_APP_ORIGIN);
    this.#network = environment.CKB_NETWORK;
    this.#now = options.now ?? (() => new Date());
    this.#randomNonce = options.randomNonce ?? (() => randomBytes(32).toString("base64url"));
    this.#randomSessionToken =
      options.randomSessionToken ?? (() => randomBytes(32).toString("base64url"));
    this.#randomUuid = options.randomUuid ?? randomUUID;
  }

  async issue(input: unknown): Promise<AuthChallengeResponse> {
    const request = parseChallengeRequest(input);
    const challengeId = this.#randomUuid();
    const nonce = this.#randomNonce();
    const issuedAt = this.#now();
    const expiresAt = new Date(issuedAt.getTime() + AUTH_CHALLENGE_TTL_MS);
    if (!UUID_PATTERN.test(challengeId) || !OPAQUE_TOKEN_PATTERN.test(nonce)) {
      throw new Error("auth randomness provider returned malformed data");
    }
    await this.#database.insert(authChallenges).values({
      id: challengeId,
      networkId: this.#network,
      ownerLockHash: request.ownerLockHash,
      nonceHash: sha256(nonce),
      expiresAt,
      createdAt: issuedAt,
    });
    return Object.freeze({
      challengeId,
      domain: this.#domain,
      expiresAt: expiresAt.toISOString(),
      message: formatAuthChallengeMessage({
        challengeId,
        domain: this.#domain,
        expiresAt,
        issuedAt,
        network: this.#network,
        nonce,
        ownerLockHash: request.ownerLockHash,
      }),
      network: this.#network,
      nonce,
    });
  }

  async verify(input: unknown): Promise<AuthSessionResponse> {
    const request = parseVerifyRequest(input);
    const token = this.#randomSessionToken();
    const sessionId = this.#randomUuid();
    if (!OPAQUE_TOKEN_PATTERN.test(token) || !UUID_PATTERN.test(sessionId)) {
      throw new Error("auth randomness provider returned malformed data");
    }

    return this.#database.transaction(async (transaction) => {
      const [challenge] = await transaction
        .select()
        .from(authChallenges)
        .where(
          and(
            eq(authChallenges.id, request.challengeId),
            eq(authChallenges.networkId, this.#network),
          ),
        )
        .for("update")
        .limit(1);
      if (challenge === undefined) throw unauthorized("AUTH_CHALLENGE_INVALID");
      const now = this.#now();
      if (challenge.consumedAt !== null) throw unauthorized("AUTH_CHALLENGE_USED");
      if (challenge.expiresAt.getTime() <= now.getTime()) {
        throw unauthorized("AUTH_CHALLENGE_EXPIRED");
      }
      if (!equalHash(challenge.nonceHash, sha256(request.nonce))) {
        throw unauthorized("AUTH_CHALLENGE_INVALID");
      }
      const ownerLock = Script.from(request.ownerLock);
      if (ownerLock.hash() !== challenge.ownerLockHash) {
        throw unauthorized("AUTH_CHALLENGE_INVALID");
      }
      const message = formatAuthChallengeMessage({
        challengeId: challenge.id,
        domain: this.#domain,
        expiresAt: challenge.expiresAt,
        issuedAt: challenge.createdAt,
        network: this.#network,
        nonce: request.nonce,
        ownerLockHash: challenge.ownerLockHash,
      });
      if (!(await signatureMatchesOwner(message, request.ownerLock, request.signature))) {
        throw unauthorized("AUTH_SIGNATURE_INVALID");
      }
      const expiresAt = new Date(now.getTime() + AUTH_SESSION_TTL_MS);
      await transaction
        .update(authChallenges)
        .set({ consumedAt: now })
        .where(and(eq(authChallenges.id, challenge.id), isNull(authChallenges.consumedAt)));
      await transaction.insert(authSessions).values({
        id: sessionId,
        networkId: this.#network,
        ownerLockHash: challenge.ownerLockHash,
        tokenHash: sha256(token),
        scope: AUTH_SESSION_SCOPE,
        expiresAt,
        createdAt: now,
      });
      return Object.freeze({
        expiresAt: expiresAt.toISOString(),
        network: this.#network,
        ownerLockHash: challenge.ownerLockHash,
        scope: [AUTH_SESSION_SCOPE] as const,
        sessionToken: token,
      });
    });
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedSession> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (match === null) throw unauthorized("AUTH_SESSION_INVALID");
    const token = match[1];
    if (token === undefined) throw unauthorized("AUTH_SESSION_INVALID");
    const now = this.#now();
    const [session] = await this.#database
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.networkId, this.#network),
          eq(authSessions.tokenHash, sha256(token)),
          eq(authSessions.scope, AUTH_SESSION_SCOPE),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .limit(1);
    if (session === undefined) throw unauthorized("AUTH_SESSION_INVALID");
    return Object.freeze({
      expiresAt: session.expiresAt,
      id: session.id,
      network: session.networkId,
      ownerLockHash: session.ownerLockHash,
      scope: AUTH_SESSION_SCOPE,
    });
  }
}

export class AuthController {
  readonly #auth: AuthService;

  constructor(auth: AuthService) {
    this.#auth = auth;
  }

  issue(body: unknown): Promise<AuthChallengeResponse> {
    return this.#auth.issue(body);
  }

  verify(body: unknown): Promise<AuthSessionResponse> {
    return this.#auth.verify(body);
  }

  async current(
    authorization: string | undefined,
  ): Promise<Omit<AuthSessionResponse, "sessionToken">> {
    const session = await this.#auth.authenticate(authorization);
    return {
      expiresAt: session.expiresAt.toISOString(),
      network: session.network,
      ownerLockHash: session.ownerLockHash,
      scope: [AUTH_SESSION_SCOPE],
    };
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const challengeSchema = {
  type: "object",
  required: ["ownerLockHash"],
  additionalProperties: false,
  properties: { ownerLockHash: hashSchema },
};
const scriptSchema = {
  type: "object",
  required: ["args", "codeHash", "hashType"],
  additionalProperties: false,
  properties: {
    args: { type: "string", pattern: "^0x[0-9a-f]{40}$" },
    codeHash: hashSchema,
    hashType: { type: "string", enum: ["data", "data1", "type"] },
  },
};
const verifySchema = {
  type: "object",
  required: ["challengeId", "nonce", "ownerLock", "signature"],
  additionalProperties: false,
  properties: {
    challengeId: { type: "string", format: "uuid" },
    nonce: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    ownerLock: scriptSchema,
    signature: {
      type: "object",
      required: ["identity", "signature", "signType"],
      additionalProperties: false,
      properties: {
        identity: { type: "string", pattern: "^0x(?:02|03)[0-9a-f]{64}$" },
        signature: { type: "string", pattern: "^0x[0-9a-f]{130}$" },
        signType: { type: "string", enum: [SignerSignType.CkbSecp256k1] },
      },
    },
  },
};
const sessionResponseSchema = {
  type: "object",
  required: ["expiresAt", "network", "ownerLockHash", "scope", "sessionToken"],
  properties: {
    expiresAt: { type: "string", format: "date-time" },
    network: { type: "string", enum: ["ckb_dev", "ckb_testnet"] },
    ownerLockHash: hashSchema,
    scope: { type: "array", items: { type: "string", enum: [AUTH_SESSION_SCOPE] } },
    sessionToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  },
};

Inject(AuthService)(AuthController, undefined, 0);
Controller("auth")(AuthController);
ApiTags("authentication")(AuthController);

Post("challenge")(
  AuthController.prototype,
  "issue",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "issue")!,
);
Body()(AuthController.prototype, "issue", 0);
ApiOperation({ summary: "Issue a single-use wallet authentication challenge" })(
  AuthController.prototype,
  "issue",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "issue")!,
);
ApiCreatedResponse({
  schema: {
    type: "object",
    required: ["challengeId", "domain", "expiresAt", "message", "network", "nonce"],
    properties: {
      challengeId: { type: "string", format: "uuid" },
      domain: { type: "string", format: "uri" },
      expiresAt: { type: "string", format: "date-time" },
      message: { type: "string" },
      network: { type: "string", enum: ["ckb_dev", "ckb_testnet"] },
      nonce: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    },
  },
})(
  AuthController.prototype,
  "issue",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "issue")!,
);
ApiBody({ schema: challengeSchema })(
  AuthController.prototype,
  "issue",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "issue")!,
);

Post("verify")(
  AuthController.prototype,
  "verify",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "verify")!,
);
Body()(AuthController.prototype, "verify", 0);
ApiOperation({ summary: "Verify a CCC wallet signature and create an off-chain settings session" })(
  AuthController.prototype,
  "verify",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "verify")!,
);
ApiCreatedResponse({ schema: sessionResponseSchema })(
  AuthController.prototype,
  "verify",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "verify")!,
);
ApiBody({ schema: verifySchema })(
  AuthController.prototype,
  "verify",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "verify")!,
);

Get("session")(
  AuthController.prototype,
  "current",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "current")!,
);
Headers("authorization")(AuthController.prototype, "current", 0);
ApiBearerAuth()(
  AuthController.prototype,
  "current",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "current")!,
);
ApiOperation({ summary: "Read the current off-chain settings session" })(
  AuthController.prototype,
  "current",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "current")!,
);
ApiOkResponse({
  schema: {
    ...sessionResponseSchema,
    required: ["expiresAt", "network", "ownerLockHash", "scope"],
    properties: Object.fromEntries(
      Object.entries(sessionResponseSchema.properties).filter(([name]) => name !== "sessionToken"),
    ),
  },
})(
  AuthController.prototype,
  "current",
  Object.getOwnPropertyDescriptor(AuthController.prototype, "current")!,
);

for (const method of ["issue", "verify"] as const) {
  ApiBadRequestResponse({ description: "Malformed authentication request" })(
    AuthController.prototype,
    method,
    Object.getOwnPropertyDescriptor(AuthController.prototype, method)!,
  );
}
for (const method of ["verify", "current"] as const) {
  ApiUnauthorizedResponse({
    description: "Invalid, expired, or already-used authentication proof",
  })(
    AuthController.prototype,
    method,
    Object.getOwnPropertyDescriptor(AuthController.prototype, method)!,
  );
}
