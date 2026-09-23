import { randomUUID } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  PERSONAL,
  blake160,
  blake2b,
  bytesToHex,
  hexToBytes,
  scriptToHash,
} from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type Hash32, type ScriptIdentity } from "@ckb-automata/core";

import type { ConfirmationAttempt, ConfirmationTransition } from "./confirmation.ts";
import { operatorLockArgs } from "./signing.ts";

export const EXECUTOR_RECEIPT_SCHEMA = "ckb-automata/executor-receipt/v1" as const;
export const EXECUTOR_RECEIPT_AUTHORITY = "non_authoritative" as const;

const RECEIPT_DOMAIN = new TextEncoder().encode(`${EXECUTOR_RECEIPT_SCHEMA}\0`);
const TERMINAL_RECEIPT_STATES = ["confirmed", "conflicted", "dropped"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{7,64}|unversioned)$/;

export type ExecutorReceiptOutcome = (typeof TERMINAL_RECEIPT_STATES)[number];

export interface ExecutorReceiptPayload {
  readonly schema: typeof EXECUTOR_RECEIPT_SCHEMA;
  readonly authority: typeof EXECUTOR_RECEIPT_AUTHORITY;
  readonly network: string;
  readonly jobId: Hash32;
  readonly sequence: string;
  readonly attemptId: string;
  readonly transactionHash: Hash32;
  readonly executor: {
    readonly lockHash: Hash32;
    readonly lock: ScriptIdentity;
    readonly publicKey: `0x${string}`;
    readonly keyId: string;
  };
  readonly timestamps: {
    readonly submittedAt: string;
    readonly issuedAt: string;
  };
  readonly chain: {
    readonly block?: {
      readonly number: string;
      readonly hash: Hash32;
      readonly source: string;
    };
    readonly relatedTransactionHash?: Hash32;
    readonly successorOutPoint?: {
      readonly txHash: Hash32;
      readonly index: string;
    };
  };
  readonly outcome: {
    readonly state: ExecutorReceiptOutcome;
    readonly errorCode?: string;
  };
  readonly software: {
    readonly version: string;
    readonly revision: string;
  };
}

export interface ExecutorReceipt {
  readonly receiptId: string;
  readonly attemptId: string;
  readonly executorLockHash: Hash32;
  readonly payload: ExecutorReceiptPayload;
  readonly signature: `0x${string}`;
  readonly keyId: string;
  readonly createdAt: Date;
}

export interface ConfirmationReceiptIssuer {
  issue(
    attempt: ConfirmationAttempt,
    transition: ConfirmationTransition,
    issuedAt: Date,
  ): ExecutorReceipt;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("receipt contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("receipt contains a value that cannot be canonicalized");
}

export function executorReceiptDigest(payload: ExecutorReceiptPayload): Uint8Array {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(RECEIPT_DOMAIN);
  hasher.update(new TextEncoder().encode(canonicalJson(payload)));
  return hasher.digest("binary") as Uint8Array;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function verifyExecutorReceipt(receipt: ExecutorReceipt): boolean {
  try {
    const { payload } = receipt;
    const blockRequired =
      payload.outcome.state === "confirmed" || payload.outcome.state === "conflicted";
    const relatedRequired = payload.outcome.state === "conflicted";
    if (
      payload.schema !== EXECUTOR_RECEIPT_SCHEMA ||
      payload.authority !== EXECUTOR_RECEIPT_AUTHORITY ||
      payload.network.length === 0 ||
      !UUID_PATTERN.test(receipt.receiptId) ||
      !UUID_PATTERN.test(payload.attemptId) ||
      receipt.attemptId !== payload.attemptId ||
      receipt.executorLockHash !== payload.executor.lockHash ||
      receipt.keyId !== payload.executor.keyId ||
      receipt.keyId !== `ckb-secp256k1:${payload.executor.lock.args}` ||
      !TERMINAL_RECEIPT_STATES.includes(payload.outcome.state) ||
      !DECIMAL_PATTERN.test(payload.sequence) ||
      blockRequired !== (payload.chain.block !== undefined) ||
      relatedRequired !== (payload.chain.relatedTransactionHash !== undefined) ||
      !/^0x[0-9a-f]{66}$/.test(payload.executor.publicKey) ||
      !/^0x[0-9a-f]{128}$/.test(receipt.signature) ||
      !isCanonicalTimestamp(payload.timestamps.submittedAt) ||
      !isCanonicalTimestamp(payload.timestamps.issuedAt) ||
      payload.timestamps.submittedAt > payload.timestamps.issuedAt ||
      !VERSION_PATTERN.test(payload.software.version) ||
      !REVISION_PATTERN.test(payload.software.revision) ||
      receipt.createdAt.toISOString() !== payload.timestamps.issuedAt
    ) {
      return false;
    }
    parseHash32(payload.jobId);
    parseHash32(payload.transactionHash);
    parseHash32(payload.executor.lockHash);
    if (payload.chain.block !== undefined) {
      if (!DECIMAL_PATTERN.test(payload.chain.block.number)) return false;
      parseHash32(payload.chain.block.hash);
    }
    if (payload.chain.relatedTransactionHash !== undefined) {
      parseHash32(payload.chain.relatedTransactionHash);
    }
    if (payload.chain.successorOutPoint !== undefined) {
      parseHash32(payload.chain.successorOutPoint.txHash);
      if (!DECIMAL_PATTERN.test(payload.chain.successorOutPoint.index)) return false;
    }
    if (parseHash32(scriptToHash(payload.executor.lock)) !== payload.executor.lockHash)
      return false;
    if (`0x${blake160(payload.executor.publicKey, "hex")}` !== payload.executor.lock.args)
      return false;
    return secp256k1.verify(
      hexToBytes(receipt.signature),
      executorReceiptDigest(payload),
      hexToBytes(payload.executor.publicKey),
      { prehash: false, lowS: true, format: "compact" },
    );
  } catch {
    return false;
  }
}

export class ExecutorReceiptSigner implements ConfirmationReceiptIssuer {
  readonly #network: string;
  readonly #privateKey: Uint8Array;
  readonly #executorLock: ScriptIdentity;
  readonly #executorLockHash: Hash32;
  readonly #publicKey: `0x${string}`;
  readonly #keyId: string;
  readonly #version: string;
  readonly #revision: string;
  readonly #receiptId: () => string;

  constructor(options: {
    readonly network: string;
    readonly privateKey: string;
    readonly executorLock: ScriptIdentity;
    readonly version: string;
    readonly revision: string;
    readonly receiptId?: () => string;
  }) {
    if (operatorLockArgs(options.privateKey) !== options.executorLock.args) {
      throw new Error("receipt signing key does not control the executor lock");
    }
    if (!VERSION_PATTERN.test(options.version)) {
      throw new TypeError("receipt software version is invalid");
    }
    if (!REVISION_PATTERN.test(options.revision)) {
      throw new TypeError("receipt software revision is invalid");
    }
    this.#network = options.network;
    this.#privateKey = hexToBytes(options.privateKey);
    this.#executorLock = Object.freeze({ ...options.executorLock });
    this.#executorLockHash = parseHash32(scriptToHash(options.executorLock));
    this.#publicKey = bytesToHex(secp256k1.getPublicKey(this.#privateKey, true)) as `0x${string}`;
    this.#keyId = `ckb-secp256k1:${options.executorLock.args}`;
    this.#version = options.version;
    this.#revision = options.revision;
    this.#receiptId = options.receiptId ?? randomUUID;
  }

  issue(
    attempt: ConfirmationAttempt,
    transition: ConfirmationTransition,
    issuedAt: Date,
  ): ExecutorReceipt {
    if (!TERMINAL_RECEIPT_STATES.includes(transition.state as ExecutorReceiptOutcome)) {
      throw new Error("receipts can only record terminal executor outcomes");
    }
    if (
      (transition.state === "confirmed" || transition.state === "conflicted") &&
      transition.block === undefined
    ) {
      throw new Error("confirmed and conflicted receipts require a canonical block reference");
    }
    if (transition.state === "conflicted" && transition.relatedTransactionHash === undefined) {
      throw new Error("conflicted receipts require the canonical consuming transaction");
    }
    if (!Number.isFinite(issuedAt.getTime())) throw new TypeError("receipt issue time is invalid");
    if (issuedAt < attempt.submittedAt) {
      throw new Error("receipt issue time cannot precede transaction submission");
    }
    const outcome = transition.state as ExecutorReceiptOutcome;
    const payload = Object.freeze({
      schema: EXECUTOR_RECEIPT_SCHEMA,
      authority: EXECUTOR_RECEIPT_AUTHORITY,
      network: this.#network,
      jobId: attempt.jobId,
      sequence: attempt.sequence,
      attemptId: attempt.attemptId,
      transactionHash: attempt.transactionHash,
      executor: Object.freeze({
        lockHash: this.#executorLockHash,
        lock: this.#executorLock,
        publicKey: this.#publicKey,
        keyId: this.#keyId,
      }),
      timestamps: Object.freeze({
        submittedAt: attempt.submittedAt.toISOString(),
        issuedAt: issuedAt.toISOString(),
      }),
      chain: Object.freeze({
        ...(transition.block === undefined
          ? {}
          : {
              block: Object.freeze({
                number: transition.block.blockNumber,
                hash: transition.block.blockHash,
                source: transition.block.source,
              }),
            }),
        ...(transition.relatedTransactionHash === undefined
          ? {}
          : { relatedTransactionHash: transition.relatedTransactionHash }),
        ...(transition.successorOutPoint === undefined
          ? {}
          : { successorOutPoint: transition.successorOutPoint }),
      }),
      outcome: Object.freeze({
        state: outcome,
        ...(transition.errorCode === undefined ? {} : { errorCode: transition.errorCode }),
      }),
      software: Object.freeze({ version: this.#version, revision: this.#revision }),
    } satisfies ExecutorReceiptPayload);
    const signature = bytesToHex(
      secp256k1.sign(executorReceiptDigest(payload), this.#privateKey, {
        prehash: false,
        lowS: true,
        format: "compact",
      }),
    ) as `0x${string}`;
    return Object.freeze({
      receiptId: this.#receiptId(),
      attemptId: attempt.attemptId,
      executorLockHash: this.#executorLockHash,
      payload,
      signature,
      keyId: this.#keyId,
      createdAt: new Date(issuedAt),
    });
  }
}
