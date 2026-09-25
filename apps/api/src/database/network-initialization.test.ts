import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStoredNetwork,
  resolveNetworkInitialization,
  type NetworkInitializationRecord,
} from "./network-initialization.ts";

const expected: NetworkInitializationRecord = Object.freeze({
  confirmationDepth: 24,
  deploymentManifestHash: "8902af74e77e28fc10c4d73eae37a6343e788ede98cd90c7a2add2170525bf38",
  genesisHash: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  networkId: "ckb_testnet",
  rpcProfile: "testnet-public",
});

test("resolves public testnet metadata from the integrity-checked deployment registry", async () => {
  assert.deepEqual(
    await resolveNetworkInitialization({
      genesisHash: expected.genesisHash,
      networkId: expected.networkId,
      rpcProfile: expected.rpcProfile,
    }),
    expected,
  );
});

test("rejects an unknown genesis, network mismatch, and malformed profile", async () => {
  await assert.rejects(
    resolveNetworkInitialization({
      genesisHash: `0x${"ff".repeat(32)}`,
      networkId: expected.networkId,
      rpcProfile: expected.rpcProfile,
    }),
    /not_found/,
  );
  await assert.rejects(
    resolveNetworkInitialization({
      genesisHash: expected.genesisHash,
      networkId: "ckb_dev",
      rpcProfile: expected.rpcProfile,
    }),
    /does not match/,
  );
  await assert.rejects(
    resolveNetworkInitialization({
      genesisHash: expected.genesisHash,
      networkId: expected.networkId,
      rpcProfile: "Testnet Public",
    }),
    /not a valid database RPC profile/,
  );
});

test("accepts only stored metadata that exactly matches the verified deployment", () => {
  assert.doesNotThrow(() =>
    assertStoredNetwork(
      {
        confirmation_depth: expected.confirmationDepth,
        deployment_manifest_hash: expected.deploymentManifestHash,
        genesis_hash: expected.genesisHash,
        id: expected.networkId,
        rpc_profile: expected.rpcProfile,
      },
      expected,
    ),
  );
  assert.throws(
    () =>
      assertStoredNetwork(
        {
          confirmation_depth: 1,
          deployment_manifest_hash: expected.deploymentManifestHash,
          genesis_hash: expected.genesisHash,
          id: expected.networkId,
          rpc_profile: expected.rpcProfile,
        },
        expected,
      ),
    /conflicts with the verified deployment manifest/,
  );
});
