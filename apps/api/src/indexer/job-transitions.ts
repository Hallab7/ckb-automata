import { and, eq, sql } from "drizzle-orm";

import { WitnessArgs, type ClientBlock } from "@ckb-ccc/shell";

import { parseBlockNumber, parseHash32, type RegisteredDeployment } from "@ckb-automata/core";

import type { CkbReadClient } from "../ckb-client.ts";
import type { AutomataDatabase } from "../database/client.ts";
import { jobEvents, jobs, jobVersions } from "../database/schema.ts";
import { extractSupportedJobCells, type DiscoveredJobCell } from "./job-discovery.ts";

export type JobTransitionKind =
  "one_shot" | "recurring" | "cancelled" | "recovered" | "topped_up" | "consumed_by_other";

export interface JobTransitionResult {
  readonly indexedTransitions: number;
  readonly terminalTransitions: number;
  readonly successorTransitions: number;
  readonly consumedByOther: number;
}

type WitnessOperation = "execute" | "cancel" | "recover" | "top_up" | "unknown";

function hexBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) throw new TypeError("witness bytes are not canonical");
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function witnessOperation(witness: string | undefined): WitnessOperation {
  try {
    const inputType = WitnessArgs.fromBytes(witness ?? "0x").inputType;
    if (!inputType) return "unknown";
    const bytes = hexBytes(inputType);
    if (bytes.length === 1 && bytes[0] === 1) return "cancel";
    if (bytes.length === 1 && bytes[0] === 2) return "recover";
    if (bytes.length === 5 && bytes[0] === 3) return "top_up";
    if (bytes[0] === 0 && bytes.length >= 42) {
      const controlledCount = bytes[37] ?? 0;
      if (
        controlledCount >= 1 &&
        controlledCount <= 16 &&
        bytes.length === 38 + controlledCount * 4
      ) {
        return "execute";
      }
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

export function classifyJobTransition(
  witness: string | undefined,
  hasSuccessor: boolean,
): JobTransitionKind {
  switch (witnessOperation(witness)) {
    case "execute":
      return hasSuccessor ? "recurring" : "one_shot";
    case "cancel":
      return hasSuccessor ? "consumed_by_other" : "cancelled";
    case "recover":
      return hasSuccessor ? "consumed_by_other" : "recovered";
    case "top_up":
      return hasSuccessor ? "topped_up" : "consumed_by_other";
    case "unknown":
      return "consumed_by_other";
  }
}

function dataBuffer(value: `0x${string}`): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function eventDate(timestamp: bigint): Date {
  if (timestamp < 0n || timestamp > 8_640_000_000_000_000n) {
    throw new RangeError("block timestamp is outside the JavaScript date range");
  }
  return new Date(Number(timestamp));
}

function eventType(kind: JobTransitionKind): string {
  return `job_${kind}`;
}

function successorFor(
  candidates: readonly DiscoveredJobCell[],
  txHash: string,
  jobId: string,
): DiscoveredJobCell | undefined {
  const matches = candidates.filter(
    (candidate) => candidate.outPoint.txHash === txHash && candidate.jobId === jobId,
  );
  if (matches.length > 1) throw new Error("consuming transaction has multiple Job Cell successors");
  return matches[0];
}

export class JobTransitionIndexer {
  readonly #database: AutomataDatabase;
  readonly #ckbClient: Pick<CkbReadClient, "getBlockByNumber">;

  constructor(database: AutomataDatabase, ckbClient: Pick<CkbReadClient, "getBlockByNumber">) {
    this.#database = database;
    this.#ckbClient = ckbClient;
  }

  async scanBlock(
    blockNumberValue: bigint,
    deployment: RegisteredDeployment,
  ): Promise<JobTransitionResult> {
    const blockNumber = parseBlockNumber(blockNumberValue);
    const block = await this.#ckbClient.getBlockByNumber(blockNumber);
    if (!block) throw new Error("canonical block is unavailable");
    if (BigInt(block.header.number) !== blockNumber) {
      throw new Error("CKB client returned a block at the wrong height");
    }
    return this.indexBlock(block, deployment);
  }

  async indexBlock(
    block: ClientBlock,
    deployment: RegisteredDeployment,
  ): Promise<JobTransitionResult> {
    const successors = extractSupportedJobCells(block, deployment).cells;
    const blockNumber = parseBlockNumber(block.header.number.toString());
    const blockHash = parseHash32(block.header.hash);
    const timestamp = BigInt(block.header.timestamp);
    let indexedTransitions = 0;
    let terminalTransitions = 0;
    let successorTransitions = 0;
    let consumedByOther = 0;

    await this.#database.transaction(async (databaseTransaction) => {
      await databaseTransaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${deployment.network}, 0))`,
      );
      for (const [transactionIndex, chainTransaction] of block.transactions.entries()) {
        const txHash = parseHash32(chainTransaction.hash());
        for (const [inputIndex, input] of chainTransaction.inputs.entries()) {
          const [consumed] = await databaseTransaction
            .select({
              id: jobVersions.id,
              jobId: jobVersions.jobId,
              sequence: jobVersions.sequence,
              outpointTxHash: jobVersions.outpointTxHash,
              outpointIndex: jobVersions.outpointIndex,
            })
            .from(jobVersions)
            .where(
              and(
                eq(jobVersions.networkId, deployment.network),
                eq(jobVersions.outpointTxHash, input.previousOutput.txHash),
                eq(jobVersions.outpointIndex, input.previousOutput.index.toString()),
                eq(jobVersions.status, "live"),
              ),
            )
            .limit(1);
          if (!consumed) continue;

          const successor = successorFor(successors, txHash, consumed.jobId);
          const kind = classifyJobTransition(chainTransaction.witnesses[inputIndex], !!successor);
          await databaseTransaction
            .update(jobVersions)
            .set({ status: "spent", spentTxHash: txHash })
            .where(eq(jobVersions.id, consumed.id));

          if (successor) {
            await databaseTransaction.insert(jobVersions).values({
              networkId: successor.networkId,
              jobId: successor.jobId,
              sequence: successor.sequence.toString(),
              outpointTxHash: successor.outPoint.txHash,
              outpointIndex: successor.outPoint.index.toString(),
              status: "live",
              capacity: successor.capacity.toString(),
              data: dataBuffer(successor.data),
              observedBlockNumber: successor.provenance.blockNumber.toString(),
              observedBlockHash: successor.provenance.blockHash,
              transactionIndex: successor.provenance.transactionIndex.toString(),
            });
            await databaseTransaction
              .update(jobs)
              .set({
                outpointTxHash: successor.outPoint.txHash,
                outpointIndex: successor.outPoint.index.toString(),
                sequence: successor.sequence.toString(),
                ownerLockHash: successor.ownerLockHash,
                policyScriptHash: successor.policyScriptHash,
                policyKind: successor.policyKind,
                state: "live",
                capacity: successor.capacity.toString(),
                data: dataBuffer(successor.data),
                blockNumber: successor.provenance.blockNumber.toString(),
                blockHash: successor.provenance.blockHash,
                transactionIndex: successor.provenance.transactionIndex.toString(),
                updatedAt: new Date(),
              })
              .where(and(eq(jobs.networkId, deployment.network), eq(jobs.jobId, consumed.jobId)));
            successorTransitions += 1;
          } else {
            await databaseTransaction
              .update(jobs)
              .set({
                state: "spent",
                blockNumber: blockNumber.toString(),
                blockHash,
                transactionIndex: transactionIndex.toString(),
                updatedAt: new Date(),
              })
              .where(and(eq(jobs.networkId, deployment.network), eq(jobs.jobId, consumed.jobId)));
            terminalTransitions += 1;
          }

          if (kind === "consumed_by_other") consumedByOther += 1;
          await databaseTransaction.insert(jobEvents).values({
            networkId: deployment.network,
            jobId: consumed.jobId,
            eventType: eventType(kind),
            source: "indexed",
            blockNumber: blockNumber.toString(),
            blockHash,
            txHash,
            payload: {
              transactionIndex: transactionIndex.toString(),
              previousOutpoint: {
                txHash: consumed.outpointTxHash,
                index: consumed.outpointIndex,
              },
              successorOutpoint: successor
                ? { txHash: successor.outPoint.txHash, index: successor.outPoint.index.toString() }
                : null,
            },
            occurredAt: eventDate(timestamp),
          });
          indexedTransitions += 1;
        }
      }
    });

    return Object.freeze({
      indexedTransitions,
      terminalTransitions,
      successorTransitions,
      consumedByOther,
    });
  }
}
