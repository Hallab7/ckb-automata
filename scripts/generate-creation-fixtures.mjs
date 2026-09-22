import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";

import {
  buildDeadlineCreation,
  buildRecurringCreation,
  deploymentRegistry,
  parseHash32,
  parseOutPoint,
} from "../packages/core/src/index.ts";
import { JobDataV1 } from "../packages/molecule/src/index.ts";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { serializeRawTransaction } = requireFromCore("@nervosnetwork/ckb-sdk-utils");

const deadlineUrl = new URL("../contracts/fixtures/deadline_creation_v1.json", import.meta.url);
const recurringUrl = new URL("../contracts/fixtures/recurring_creation_v1.json", import.meta.url);
const conformanceUrl = new URL("../contracts/fixtures/sdk_conformance_v1.json", import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function writeJson(url, value) {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
}

const [genesisHash] = deploymentRegistry.genesisHashes;
if (!genesisHash) throw new Error("deployment registry is empty");
const loaded = await deploymentRegistry.load(genesisHash);
if (loaded.status !== "ok") {
  throw new Error(`local deployment is unavailable (${loaded.status})`);
}
const deployment = loaded.deployment;

const deadline = await readJson(deadlineUrl);
const deadlineBuild = buildDeadlineCreation({
  deployment,
  pledges: deadline.pledges.map((pledge) => ({
    outPoint: parseOutPoint({ txHash: pledge.tx_hash, index: pledge.index }),
    refundLockHash: parseHash32(pledge.refund_lock_hash),
    amount: pledge.amount,
  })),
  target: deadline.target,
  deadlineBlock: deadline.deadline_block,
  successLockHash: parseHash32(deadline.success_lock_hash),
  cancelLockHash: parseHash32(deadline.cancel_lock_hash),
  reward: deadline.reward,
  creatorNonce: deadline.creator_nonce,
  creationFee: {
    transactionBytes: deadline.creation_fee.transaction_bytes,
    feeRatePerKilobyte: deadline.creation_fee.fee_rate_per_kilobyte,
  },
});
deadline.expected = {
  intent_hash: deadlineBuild.intentHash,
  campaign_id: deadlineBuild.campaignId,
  campaign_type_hash: deadlineBuild.intent.campaignTypeHash,
  policy_script_hash: deadlineBuild.intent.policyScriptHash,
  payload_hash: deadlineBuild.intent.payloadHash,
  trigger_params_hash: deadlineBuild.intent.triggerParamsHash,
  refund_commitment: deadlineBuild.intent.refundCommitment,
  job_id: deadlineBuild.jobId,
  campaign_data: deadlineBuild.campaignData,
  job_data: deadlineBuild.jobData,
  witness_0: deadlineBuild.transaction.witnesses[0],
  raw_transaction: serializeRawTransaction(deadlineBuild.transaction),
};
await writeJson(deadlineUrl, deadline);

const recurring = await readJson(recurringUrl);
const recurringBuild = buildRecurringCreation({
  deployment,
  ownerLockHash: parseHash32(recurring.owner_lock_hash),
  recipientLockHash: parseHash32(recurring.recipient_lock_hash),
  amount: recurring.amount,
  intervalBlocks: recurring.interval_blocks,
  firstNotBefore: recurring.first_not_before,
  totalRuns: recurring.total_runs,
  reward: recurring.reward,
  creatorNonce: recurring.creator_nonce,
  creationFee: {
    transactionBytes: recurring.creation_fee.transaction_bytes,
    feeRatePerKilobyte: recurring.creation_fee.fee_rate_per_kilobyte,
  },
});
recurring.expected = {
  policy_script_hash: recurringBuild.intent.policyScriptHash,
  payload_hash: recurringBuild.intent.payloadHash,
  intent_hash: recurringBuild.intentHash,
  job_id: recurringBuild.jobId,
  recurring_payload: recurringBuild.recurringPayload,
  job_data: recurringBuild.jobData,
  raw_transaction: serializeRawTransaction(recurringBuild.transaction),
};
await writeJson(recurringUrl, recurring);

function jsonView(data, policy) {
  const job = JobDataV1.unpack(Buffer.from(data.slice(2), "hex"));
  return {
    job_id: `0x${Buffer.from(job.job_id).toString("hex")}`,
    sequence: job.sequence.toString(),
    remaining_runs: job.remaining_runs.toString(),
    policy,
  };
}

const recurringJob = JobDataV1.unpack(Buffer.from(recurring.expected.job_data.slice(2), "hex"));
const unsupportedBinary = `0x${Buffer.from(
  JobDataV1.pack({ ...recurringJob, version: 2 }),
).toString("hex")}`;
const recurringJson = jsonView(recurring.expected.job_data, "recurring");
const deadlineJson = jsonView(deadline.expected.job_data, "deadline");
await writeJson(conformanceUrl, {
  version: 1,
  cases: [
    {
      id: "recurring-creation-valid",
      policy: "recurring",
      policy_args: "0x",
      json: recurringJson,
      binary: recurring.expected.job_data,
      transaction: recurring.expected.raw_transaction,
      expected: { json_matches_binary: true, binary_status: "ok", transaction_valid: true },
    },
    {
      id: "deadline-creation-valid",
      policy: "deadline",
      policy_args: deadline.expected.campaign_type_hash,
      json: deadlineJson,
      binary: deadline.expected.job_data,
      transaction: deadline.expected.raw_transaction,
      expected: { json_matches_binary: true, binary_status: "ok", transaction_valid: true },
    },
    {
      id: "json-sequence-mismatch",
      policy: "recurring",
      policy_args: "0x",
      json: { ...recurringJson, sequence: "1" },
      binary: recurring.expected.job_data,
      transaction: recurring.expected.raw_transaction,
      expected: { json_matches_binary: false, binary_status: "ok", transaction_valid: true },
    },
    {
      id: "unsupported-job-version",
      policy: "recurring",
      policy_args: "0x",
      json: recurringJson,
      binary: unsupportedBinary,
      transaction: "0x00",
      expected: {
        json_matches_binary: false,
        binary_status: "unsupported_version",
        transaction_valid: false,
      },
    },
    {
      id: "truncated-deadline-transaction",
      policy: "deadline",
      policy_args: deadline.expected.campaign_type_hash,
      json: deadlineJson,
      binary: deadline.expected.job_data,
      transaction: deadline.expected.raw_transaction.slice(0, -2),
      expected: { json_matches_binary: true, binary_status: "ok", transaction_valid: false },
    },
  ],
});

console.log("Regenerated creation and SDK conformance fixtures");
