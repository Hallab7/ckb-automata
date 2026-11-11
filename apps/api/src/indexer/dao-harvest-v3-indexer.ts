import type { ClientBlock } from "@ckb-ccc/shell";
import {
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseShannons,
  type DaoHarvestV3DeploymentIdentity,
  type ScriptIdentity,
} from "@ckb-automata/core";
import type { CkbReadClient } from "../ckb-client.ts";
import {
  extractDaoHarvestV3ProjectionEvents,
  type DaoHarvestV3ProjectionDeployment,
  type DaoHarvestV3ResolvedInput,
} from "./dao-harvest-v3-projection.ts";
import type { DaoHarvestV3ProjectionStore } from "./dao-harvest-v3-store.ts";

function script(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}): ScriptIdentity {
  const hashType = String(value.hashType);
  const args = String(value.args);
  if (
    !("data data1 data2 type".split(" ") as string[]).includes(hashType) ||
    !/^0x(?:[0-9a-f]{2})*$/.test(args)
  )
    throw new TypeError("resolved V3 input has an invalid script");
  return Object.freeze({
    codeHash: parseHash32(String(value.codeHash)),
    hashType: hashType as ScriptIdentity["hashType"],
    args: args as `0x${string}`,
  });
}
function projectionDeployment(
  networkId: string,
  deployment: DaoHarvestV3DeploymentIdentity,
): DaoHarvestV3ProjectionDeployment {
  return Object.freeze({
    networkId,
    jobLock: { codeHash: deployment.contracts.jobLock.codeHash, hashType: "data1" as const },
    policy: {
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1" as const,
      args: deployment.contracts.jobLock.codeHash as `0x${string}`,
    },
    vaultLock: { codeHash: deployment.contracts.vaultLock.codeHash, hashType: "data1" as const },
    compensationLock: {
      codeHash: deployment.contracts.compensationLock.codeHash,
      hashType: "data1" as const,
    },
  });
}

export class DaoHarvestV3RevisionIndexer {
  readonly #chain: Pick<CkbReadClient, "getTransactionStatus">;
  readonly #store: Pick<
    DaoHarvestV3ProjectionStore,
    "append" | "reset" | "rollback" | "trackedOutPoints"
  >;
  readonly #networkId: string;
  readonly #deployments: readonly DaoHarvestV3ProjectionDeployment[];
  constructor(
    chain: Pick<CkbReadClient, "getTransactionStatus">,
    store: Pick<DaoHarvestV3ProjectionStore, "append" | "reset" | "rollback" | "trackedOutPoints">,
    networkId: string,
    deployments: readonly DaoHarvestV3DeploymentIdentity[],
  ) {
    if (deployments.length === 0) throw new Error("at least one V3 deployment is required");
    this.#chain = chain;
    this.#store = store;
    this.#networkId = networkId;
    this.#deployments = Object.freeze(
      deployments.map((item) => projectionDeployment(networkId, item)),
    );
  }
  async projectBlock(block: ClientBlock) {
    const tracked = await this.#store.trackedOutPoints(this.#networkId);
    let events = 0;
    let snapshots = 0;
    for (const deployment of this.#deployments) {
      const resolved = await this.#resolveInputs(block, tracked, deployment);
      const extraction = extractDaoHarvestV3ProjectionEvents(block, deployment, resolved);
      if (extraction.malformed > 0)
        throw new Error("canonical block contains a malformed DAO Harvest V3 transition");
      const rebuilt = await this.#store.append(extraction.events);
      events += extraction.events.length;
      snapshots += rebuilt.length;
    }
    return Object.freeze({ events, snapshots });
  }
  rollback(networkId: string, hashes: readonly string[]) {
    return this.#store.rollback(networkId, hashes);
  }
  reset(networkId: string) {
    return this.#store.reset(networkId);
  }

  async #resolveInputs(
    block: ClientBlock,
    tracked: ReadonlySet<string>,
    deployment: DaoHarvestV3ProjectionDeployment,
  ) {
    const inBlock = new Map(
      block.transactions.map((transaction) => [transaction.hash().toString(), transaction]),
    );
    const relevant = new Set(tracked);
    for (const transaction of block.transactions) {
      const hash = transaction.hash().toString();
      transaction.outputs.forEach((output, index) => {
        if (
          [deployment.jobLock, deployment.vaultLock, deployment.compensationLock].some(
            (expected) =>
              output.lock.codeHash.toString() === expected.codeHash &&
              output.lock.hashType === expected.hashType,
          )
        )
          relevant.add(`${hash}:${index}`);
      });
    }
    const resolved = new Map<string, DaoHarvestV3ResolvedInput>();
    for (const transaction of block.transactions) {
      const creates = transaction.outputs.some(
        (output) =>
          (output.type?.codeHash.toString() === deployment.policy.codeHash &&
            output.type.hashType === deployment.policy.hashType) ||
          (output.lock.codeHash.toString() === deployment.compensationLock.codeHash &&
            output.lock.hashType === deployment.compensationLock.hashType),
      );
      const spends = transaction.inputs.some((input) =>
        relevant.has(`${input.previousOutput.txHash}:${BigInt(input.previousOutput.index)}`),
      );
      if (!creates && !spends) continue;
      for (const input of transaction.inputs) {
        const txHash = parseHash32(input.previousOutput.txHash.toString());
        const index = Number(parseOutputIndex(input.previousOutput.index.toString()));
        const cellKey = `${txHash}:${index}`;
        if (resolved.has(cellKey)) continue;
        const previous =
          inBlock.get(txHash) ?? (await this.#chain.getTransactionStatus(txHash))?.transaction;
        const output = previous?.outputs[index];
        const data = previous?.outputsData[index];
        if (!output || data === undefined)
          throw new Error(`canonical V3 input ${cellKey} could not be resolved`);
        resolved.set(
          cellKey,
          Object.freeze({
            outPoint: parseOutPoint({ txHash, index: `0x${index.toString(16)}` }),
            capacity: parseShannons(output.capacity.toString()),
            lock: script(output.lock),
            type: output.type == null ? null : script(output.type),
            data: data.toString() as `0x${string}`,
          }),
        );
      }
    }
    return Object.freeze([...resolved.values()]);
  }
}
