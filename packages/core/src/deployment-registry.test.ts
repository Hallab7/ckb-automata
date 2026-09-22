import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LOCAL_DEPLOYMENT_MANIFEST_SHA256,
  createDeploymentRegistry,
  deploymentRegistry,
  hashDeploymentManifest,
} from "./deployment-registry.ts";

const manifestUrl = new URL("../../../deploy/manifests/local.json", import.meta.url);

async function loadManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as Record<string, unknown>;
}

test("the pinned local manifest hash is canonical and order-independent", async () => {
  const manifest = await loadManifest();
  assert.equal(await hashDeploymentManifest(manifest), LOCAL_DEPLOYMENT_MANIFEST_SHA256);
  assert.equal(
    await hashDeploymentManifest(Object.fromEntries(Object.entries(manifest).toReversed())),
    LOCAL_DEPLOYMENT_MANIFEST_SHA256,
  );
});

test("genesis lookup exposes only validated script, dep, and confirmation metadata", async () => {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const result = await deploymentRegistry.load(genesisHash);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.deployment.manifestSha256, LOCAL_DEPLOYMENT_MANIFEST_SHA256);
  assert.deepEqual(result.deployment.contracts["job-lock"].script, {
    codeHash: result.deployment.manifest.contracts["job-lock"].codeHash,
    hashType: "data1",
  });
  assert.equal(
    result.deployment.contracts["job-lock"].cellDep.outPoint.txHash,
    result.deployment.confirmation.deploymentTransactionHash,
  );
  assert.equal(result.deployment.confirmation.requiredDepth, 1);
  assert.equal(result.deployment.confirmation.verificationContract, "demo-campaign-type");
  assert.ok(Object.isFrozen(result.deployment.contracts));
});

test("wrong-network lookups and manifest bindings fail closed", async () => {
  const wrongGenesis = `0x${"ff".repeat(32)}`;
  const notFound = await deploymentRegistry.load(wrongGenesis);
  assert.deepEqual(notFound, { status: "not_found", genesisHash: wrongGenesis });

  const manifest = await loadManifest();
  const wrongBinding = createDeploymentRegistry([
    {
      genesisHash: wrongGenesis,
      manifestSha256: LOCAL_DEPLOYMENT_MANIFEST_SHA256,
      manifest,
      confirmationDepth: 1,
    },
  ]);
  const boundResult = await wrongBinding.load(wrongGenesis);
  assert.equal(boundResult.status, "invalid_manifest");
  if (boundResult.status !== "invalid_manifest") return;
  assert.ok(boundResult.issues.some(({ code }) => code === "WRONG_NETWORK"));
});

test("altered manifests fail integrity before their metadata is exposed", async () => {
  const manifest = await loadManifest();
  const genesisHash = manifest["genesisHash"] as string;
  const altered = structuredClone(manifest) as {
    contracts: { "job-lock": { codeHash: string } };
  };
  altered.contracts["job-lock"].codeHash = `0x${"aa".repeat(32)}`;

  const registry = createDeploymentRegistry([
    {
      genesisHash,
      manifestSha256: LOCAL_DEPLOYMENT_MANIFEST_SHA256,
      manifest: altered,
      confirmationDepth: 1,
    },
  ]);
  const result = await registry.load(genesisHash);
  assert.equal(result.status, "integrity_mismatch");
  if (result.status !== "integrity_mismatch") return;
  assert.notEqual(result.actualSha256, result.expectedSha256);
  assert.equal("deployment" in result, false);
});

test("registry metadata rejects weak hashes, unsafe depths, and duplicate networks", async () => {
  const manifest = await loadManifest();
  const genesisHash = manifest["genesisHash"] as string;
  const valid = {
    genesisHash,
    manifestSha256: LOCAL_DEPLOYMENT_MANIFEST_SHA256,
    manifest,
    confirmationDepth: 1,
  } as const;

  assert.throws(
    () => createDeploymentRegistry([{ ...valid, manifestSha256: "not-a-digest" }]),
    TypeError,
  );
  assert.throws(() => createDeploymentRegistry([{ ...valid, confirmationDepth: 0 }]), RangeError);
  assert.throws(() => createDeploymentRegistry([valid, valid]), /duplicate deployment registry/);
});
