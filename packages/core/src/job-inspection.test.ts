import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JobDataV1, type JobDataV1Like } from "@ckb-automata/molecule";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32 } from "./chain-values.ts";
import {
  inspectJobData,
  validateDeploymentManifest,
  type DeploymentManifest,
  type ScriptIdentity,
} from "./job-inspection.ts";

interface JobFixture {
  readonly version: number;
  readonly flags: number;
  readonly job_id: string;
  readonly sequence: string;
  readonly state: number;
  readonly trigger_kind: number;
  readonly trigger_params_hash: string;
  readonly policy_script_hash: string;
  readonly payload_hash: string;
  readonly reward: string;
  readonly remaining_budget: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly remaining_runs: number;
  readonly cancel_lock_hash: string;
  readonly expected_hex: string;
}

const fixtureUrl = new URL("../../../contracts/fixtures/job_data_v1.json", import.meta.url);
const manifestUrl = new URL("../../../deploy/manifests/local.json", import.meta.url);

function hexBytes(hex: string): number[] {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new TypeError("invalid test hex");
  }
  return Array.from({ length: (hex.length - 2) / 2 }, (_, index) =>
    Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16),
  );
}

function fixtureLike(fixture: JobFixture, overrides: Partial<JobDataV1Like> = {}): JobDataV1Like {
  return {
    version: fixture.version,
    flags: fixture.flags,
    job_id: hexBytes(fixture.job_id),
    sequence: fixture.sequence,
    state: fixture.state,
    trigger_kind: fixture.trigger_kind,
    trigger_params_hash: hexBytes(fixture.trigger_params_hash),
    policy_script_hash: hexBytes(fixture.policy_script_hash),
    payload_hash: hexBytes(fixture.payload_hash),
    reward: fixture.reward,
    remaining_budget: fixture.remaining_budget,
    not_before: fixture.not_before,
    not_after: fixture.not_after,
    remaining_runs: fixture.remaining_runs,
    cancel_lock_hash: hexBytes(fixture.cancel_lock_hash),
    ...overrides,
  };
}

async function loadFixture(): Promise<JobFixture> {
  return JSON.parse(await readFile(fixtureUrl, "utf8")) as JobFixture;
}

async function loadManifest(): Promise<unknown> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as unknown;
}

function encode(fixture: JobFixture, overrides: Partial<JobDataV1Like> = {}): Uint8Array {
  return JobDataV1.pack(fixtureLike(fixture, overrides));
}

test("inspection matches the cross-language JobDataV1 golden bytes", async () => {
  const fixture = await loadFixture();
  const fromHex = inspectJobData(fixture.expected_hex);
  const fromBytes = inspectJobData(Uint8Array.from(hexBytes(fixture.expected_hex)));

  assert.deepEqual(fromBytes, fromHex);
  assert.equal(fromHex.status, "ok");
  if (fromHex.status !== "ok") return;

  assert.deepEqual(fromHex.job, {
    version: 1,
    flags: 0,
    jobId: fixture.job_id,
    sequence: 72_623_859_790_382_856n,
    state: "LIVE",
    trigger: {
      kind: 1,
      metric: "block",
      paramsHash: fixture.trigger_params_hash,
    },
    policyScriptHash: fixture.policy_script_hash,
    payloadHash: fixture.payload_hash,
    reward: 100_000_000n,
    remainingBudget: 5_000_000_000n,
    notBefore: 1_000n,
    notAfter: 2_000n,
    remainingRuns: 3n,
    cancelLockHash: fixture.cancel_lock_hash,
  });
  assert.deepEqual(fromHex.policy, {
    kind: "unresolved",
    scriptHash: fixture.policy_script_hash,
  });
});

test("malformed data, unsupported versions, and invalid live jobs are distinct", async () => {
  const fixture = await loadFixture();

  assert.equal(inspectJobData("0x0").status, "malformed");
  assert.equal(inspectJobData(fixture.expected_hex.slice(0, -2)).status, "malformed");
  assert.deepEqual(inspectJobData(encode(fixture, { version: 2 })), {
    status: "unsupported_version",
    version: 2,
  });

  const invalid = inspectJobData(
    encode(fixture, { flags: 1, state: 1, trigger_kind: 7, remaining_runs: 0 }),
  );
  assert.equal(invalid.status, "invalid_job");
  if (invalid.status !== "invalid_job") return;
  assert.deepEqual(
    invalid.issues.map(({ field }) => field),
    ["flags", "state", "triggerKind", "remainingRuns"],
  );
});

test("the deployed local manifest is structurally consistent and network-bound", async () => {
  const rawManifest = await loadManifest();
  const validation = validateDeploymentManifest(rawManifest);
  assert.equal(validation.status, "ok");
  if (validation.status !== "ok") return;

  assert.equal(validation.manifest.network, "ckb_dev");
  assert.equal(validation.manifest.contracts["job-lock"].cellDep.outPoint.index, "0x0");
  assert.ok(Object.isFrozen(validation.manifest.contracts["job-lock"].cellDep.outPoint));

  const wrongNetwork = validateDeploymentManifest(rawManifest, `0x${"ff".repeat(32)}`);
  assert.equal(wrongNetwork.status, "invalid");
  if (wrongNetwork.status !== "invalid") return;
  assert.ok(wrongNetwork.issues.some(({ code }) => code === "WRONG_NETWORK"));

  const altered = structuredClone(rawManifest) as {
    contracts: { "job-lock": { cellDep: { outPoint: { txHash: string } } } };
  };
  altered.contracts["job-lock"].cellDep.outPoint.txHash = `0x${"aa".repeat(32)}`;
  const alteredResult = validateDeploymentManifest(altered);
  assert.equal(alteredResult.status, "invalid");
  if (alteredResult.status !== "invalid") return;
  assert.ok(alteredResult.issues.some(({ code }) => code === "INCONSISTENT_DEPLOYMENT"));
});

test("inspection derives recurring and deadline metadata from the exact policy script", async () => {
  const fixture = await loadFixture();
  const manifestResult = validateDeploymentManifest(await loadManifest());
  assert.equal(manifestResult.status, "ok");
  if (manifestResult.status !== "ok") return;
  const manifest: DeploymentManifest = manifestResult.manifest;

  const recurringScript: ScriptIdentity = {
    codeHash: manifest.contracts["recurring-policy"].codeHash,
    hashType: manifest.contracts["recurring-policy"].hashType,
    args: "0x",
  };
  const recurringHash = parseHash32(scriptToHash(recurringScript));
  const recurring = inspectJobData(
    encode(fixture, { policy_script_hash: hexBytes(recurringHash) }),
    { manifest, policyScript: recurringScript, expectedGenesisHash: manifest.genesisHash },
  );
  assert.equal(recurring.status, "ok");
  if (recurring.status !== "ok") return;
  assert.deepEqual(recurring.policy, {
    kind: "recurring",
    scriptHash: recurringHash,
    contract: "recurring-policy",
  });

  const campaignTypeHash = parseHash32(`0x${"ab".repeat(32)}`);
  const deadlineScript: ScriptIdentity = {
    codeHash: manifest.contracts["deadline-policy"].codeHash,
    hashType: manifest.contracts["deadline-policy"].hashType,
    args: campaignTypeHash as `0x${string}`,
  };
  const deadlineHash = parseHash32(scriptToHash(deadlineScript));
  const deadline = inspectJobData(
    encode(fixture, { policy_script_hash: hexBytes(deadlineHash), remaining_runs: 1 }),
    { manifest, policyScript: deadlineScript },
  );
  assert.equal(deadline.status, "ok");
  if (deadline.status !== "ok") return;
  assert.deepEqual(deadline.policy, {
    kind: "deadline",
    scriptHash: deadlineHash,
    contract: "deadline-policy",
    campaignTypeHash,
  });

  const mismatch = inspectJobData(encode(fixture), {
    manifest,
    policyScript: recurringScript,
  });
  assert.equal(mismatch.status, "policy_mismatch");
});
