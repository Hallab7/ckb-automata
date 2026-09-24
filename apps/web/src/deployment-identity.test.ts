import assert from "node:assert/strict";
import test from "node:test";

import { TESTNET_DEPLOYMENT_MANIFEST_SHA256, TESTNET_GENESIS_HASH } from "@ckb-automata/core";

import {
  assertPublicDeploymentIdentity,
  requiresPublicDeploymentVerification,
} from "./deployment-identity.ts";

const expected = {
  genesisHash: TESTNET_GENESIS_HASH,
  manifestSha256: TESTNET_DEPLOYMENT_MANIFEST_SHA256,
  network: "testnet" as const,
};

test("public frontend accepts only its pinned testnet deployment identity", () => {
  assert.deepEqual(
    assertPublicDeploymentIdentity(
      {
        deploymentManifestHash: TESTNET_DEPLOYMENT_MANIFEST_SHA256,
        genesisHash: TESTNET_GENESIS_HASH,
        network: "ckb_testnet",
      },
      expected,
    ),
    {
      deploymentManifestHash: TESTNET_DEPLOYMENT_MANIFEST_SHA256,
      genesisHash: TESTNET_GENESIS_HASH,
      network: "ckb_testnet",
    },
  );
});

for (const mutation of [
  { network: "ckb" },
  { genesisHash: `0x${"0".repeat(64)}` },
  { deploymentManifestHash: "0".repeat(64) },
] as const) {
  test(`public frontend rejects changed ${Object.keys(mutation)[0]}`, () => {
    assert.throws(() =>
      assertPublicDeploymentIdentity(
        {
          deploymentManifestHash: TESTNET_DEPLOYMENT_MANIFEST_SHA256,
          genesisHash: TESTNET_GENESIS_HASH,
          network: "ckb_testnet",
          ...mutation,
        },
        expected,
      ),
    );
  });
}

test("only live workflows require backend deployment verification", () => {
  for (const pathname of ["/automations", "/automations/new/deadline", "/activity", "/settings"]) {
    assert.equal(requiresPublicDeploymentVerification(pathname), true);
  }
  for (const pathname of ["/demo", "/limitations", "/research/nervdao"]) {
    assert.equal(requiresPublicDeploymentVerification(pathname), false);
  }
});
