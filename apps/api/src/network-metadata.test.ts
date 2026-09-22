import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { ServiceUnavailableException, type LoggerService } from "@nestjs/common";
import type { ClientBlockHeader } from "@ckb-ccc/shell";

import { parseEnvironment } from "@ckb-automata/config";
import { deploymentRegistry } from "@ckb-automata/core";

import { createApiApplication } from "./bootstrap.ts";
import {
  NetworkMetadataController,
  NetworkMetadataService,
  SUPPORTED_POLICY_VERSIONS,
  type NetworkMetadataChainClient,
} from "./network-metadata.ts";

const GENESIS_HASH = "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3";
const TIP_HASH = `0x${"ab".repeat(32)}`;

function environment(rpcUrl = "http://127.0.0.1:58114") {
  return parseEnvironment({
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: rpcUrl,
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
  });
}

function tipHeader(): ClientBlockHeader {
  return { number: 42n, hash: TIP_HASH } as ClientBlockHeader;
}

function chainClient(genesisHash = GENESIS_HASH): NetworkMetadataChainClient {
  return {
    getGenesisHash: async () =>
      genesisHash as Awaited<ReturnType<NetworkMetadataChainClient["getGenesisHash"]>>,
    getTipHeader: async () => tipHeader(),
  };
}

const quietLogger: LoggerService = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

test("metadata matches direct RPC identity, tip, and the configured manifest", async () => {
  const calls: string[] = [];
  const directClient = chainClient();
  const service = new NetworkMetadataService(environment(), {
    getGenesisHash: async () => {
      calls.push("getGenesisHash");
      return directClient.getGenesisHash();
    },
    getTipHeader: async () => {
      calls.push("getTipHeader");
      return directClient.getTipHeader();
    },
  });
  const metadata = await service.read();
  const deployment = await deploymentRegistry.load(GENESIS_HASH);
  assert.equal(deployment.status, "ok");
  if (deployment.status !== "ok") return;

  assert.deepEqual(calls.toSorted(), ["getGenesisHash", "getTipHeader"]);
  assert.deepEqual(metadata, {
    network: "ckb_dev",
    genesisHash: GENESIS_HASH,
    tip: { blockNumber: "42", blockHash: TIP_HASH },
    confirmationDepth: deployment.deployment.confirmation.requiredDepth,
    deploymentManifestHash: deployment.deployment.manifestSha256,
    supportedPolicyVersions: SUPPORTED_POLICY_VERSIONS,
  });
});

test("wrong-network and client failures fail closed without leaking evidence", async () => {
  const failures: readonly NetworkMetadataChainClient[] = [
    chainClient(`0x${"ff".repeat(32)}`),
    {
      getGenesisHash: chainClient().getGenesisHash,
      getTipHeader: async () => {
        throw new Error("https://secret-token@rpc.internal");
      },
    },
  ];
  for (const failedClient of failures) {
    const controller = new NetworkMetadataController(
      new NetworkMetadataService(environment(), failedClient),
    );
    await assert.rejects(controller.get(), (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse(), {
        status: "unavailable",
        code: "NETWORK_METADATA_UNAVAILABLE",
      });
      return true;
    });
  }
});

test("versioned HTTP endpoint returns network metadata", async () => {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { id: number; method: string };
    const result =
      payload.method === "get_block_hash"
        ? GENESIS_HASH
        : {
            compact_target: "0x20010000",
            dao: `0x${"00".repeat(32)}`,
            epoch: "0x1000000000001",
            extra_hash: `0x${"44".repeat(32)}`,
            hash: TIP_HASH,
            nonce: `0x${"00".repeat(16)}`,
            number: "0x2a",
            parent_hash: `0x${"33".repeat(32)}`,
            proposals_hash: `0x${"00".repeat(32)}`,
            timestamp: "0x1234",
            transactions_root: `0x${"55".repeat(32)}`,
            version: "0x0",
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock RPC did not bind a TCP port");

  const result = await createApiApplication(environment(`http://127.0.0.1:${address.port}`), {
    logger: quietLogger,
  });
  try {
    await result.app.init();
    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        url: string;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    const response = await fastify.inject({ method: "GET", url: "/v1/network" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      network: "ckb_dev",
      genesisHash: GENESIS_HASH,
      tip: { blockNumber: "42", blockHash: TIP_HASH },
      confirmationDepth: 1,
      deploymentManifestHash: "2904b44ffa3c1f292404540f2bc6c14dc96789f888e28aa7fc2527566110e1d1",
      supportedPolicyVersions: { deadline: [1], recurring: [1] },
    });
    assert.equal((await fastify.inject({ method: "GET", url: "/network" })).statusCode, 404);
  } finally {
    await result.app.close();
    server.close();
    await once(server, "close");
  }
});
