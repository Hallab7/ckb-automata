import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ApiTransactionBuild } from "@ckb-automata/api-client";
import {
  buildDeadlineCreation,
  buildRecurringCreation,
  deploymentRegistry,
  parseDeadlineCreationRequest,
  parseHash32,
  parseRecurringCreationRequest,
  type RegisteredDeployment,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import {
  reviewTechnicalDetailsJson,
  verifyCreationReview,
  type CreationRequest,
} from "./review-model.ts";

const DEADLINE_FEE = {
  transactionBytes: { minimum: "700", maximum: "900" },
  feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
} as const;
const RECURRING_FEE = {
  transactionBytes: { minimum: "500", maximum: "800" },
  feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
} as const;
const INPUT_HASH = parseHash32(`0x${"77".repeat(32)}`);

function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

function ownerScript(registered: RegisteredDeployment): ScriptIdentity {
  return {
    codeHash: registered.manifest.secp256k1Blake160.codeHash,
    hashType: registered.manifest.secp256k1Blake160.hashType,
    args: registered.manifest.fixtureWallet.lockArg,
  };
}

function lockHasher(owner: ScriptIdentity, ownerLockHash: string) {
  return (script: ScriptIdentity): string =>
    JSON.stringify(script) === JSON.stringify(owner) ? ownerLockHash : `0x${"00".repeat(32)}`;
}

function artifact(input: {
  readonly operation: CreationRequest["operation"];
  readonly transaction: UnsignedDeadlineTransaction;
  readonly intent: unknown;
  readonly protocolIntentHash: string;
  readonly quote: unknown;
}): ApiTransactionBuild {
  const chainSnapshot = {
    tip: { blockNumber: "100", blockHash: `0x${"66".repeat(32)}` },
    deploymentManifestSha256: (input.intent as { deploymentManifestSha256: string })
      .deploymentManifestSha256,
  };
  const quoteExpiry = { afterBlock: "130", condition: "canonical_snapshot_window" } as const;
  const normalizedIntent = normalized(input.intent) as Record<string, unknown>;
  const normalizedQuote = normalized(input.quote) as Record<string, unknown>;
  const intentHash = digest({ operation: input.operation, intent: normalizedIntent });
  const policyCriticalHash = digest({
    operation: input.operation,
    intentHash,
    quote: normalizedQuote,
    chainSnapshot,
    quoteExpiry,
    transaction: input.transaction,
  });
  return {
    operation: input.operation,
    transaction: input.transaction,
    signingEntries: [
      { role: "funding", inputIndices: [], walletAction: "append_inputs_and_change" },
    ],
    intent: normalizedIntent,
    intentHash,
    protocolIntentHash: input.protocolIntentHash,
    policyCriticalHash,
    chainSnapshot,
    quoteExpiry,
    quote: normalizedQuote,
  };
}

function withQuote(
  source: ApiTransactionBuild,
  quote: Record<string, unknown>,
): ApiTransactionBuild {
  return {
    ...source,
    quote,
    policyCriticalHash: digest({
      operation: source.operation,
      intentHash: source.intentHash,
      quote,
      chainSnapshot: source.chainSnapshot,
      quoteExpiry: source.quoteExpiry,
      transaction: source.transaction,
    }),
  };
}

function withIntent(
  source: ApiTransactionBuild,
  intent: Record<string, unknown>,
): ApiTransactionBuild {
  const intentHash = digest({ operation: source.operation, intent });
  return {
    ...source,
    intent,
    intentHash,
    policyCriticalHash: digest({
      operation: source.operation,
      intentHash,
      quote: source.quote,
      chainSnapshot: source.chainSnapshot,
      quoteExpiry: source.quoteExpiry,
      transaction: source.transaction,
    }),
  };
}

function withExpiry(
  source: ApiTransactionBuild,
  quoteExpiry: Readonly<Record<string, unknown>>,
): ApiTransactionBuild {
  return {
    ...source,
    quoteExpiry,
    policyCriticalHash: digest({
      operation: source.operation,
      intentHash: source.intentHash,
      quote: source.quote,
      chainSnapshot: source.chainSnapshot,
      quoteExpiry,
      transaction: source.transaction,
    }),
  } as ApiTransactionBuild;
}

function completedTransaction(
  transaction: UnsignedDeadlineTransaction,
  owner: ScriptIdentity,
  inputCapacity: bigint,
  fee: bigint,
): UnsignedDeadlineTransaction {
  const outputCapacity = transaction.outputs.reduce(
    (total, output) => total + BigInt(output.capacity),
    0n,
  );
  const change = inputCapacity - outputCapacity - fee;
  return {
    ...transaction,
    inputs:
      transaction.inputs.length === 0
        ? [
            {
              since: "0x0",
              previousOutput: { txHash: INPUT_HASH, index: "0x0" },
            },
          ]
        : transaction.inputs,
    outputs: [
      ...transaction.outputs,
      { capacity: `0x${change.toString(16)}`, lock: owner, type: null },
    ],
    outputsData: [...transaction.outputsData, "0x"],
  };
}

async function deployment(): Promise<RegisteredDeployment> {
  const genesisHash = deploymentRegistry.genesisHashes[0];
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("fixture deployment unavailable");
  return loaded.deployment;
}

test("typed recurring transaction produces the complete human-readable review", async () => {
  const registered = await deployment();
  const owner = ownerScript(registered);
  const ownerLockHash = parseHash32(`0x${"44".repeat(32)}`);
  const value = parseRecurringCreationRequest({
    ownerLockHash,
    recipientLockHash: ownerLockHash,
    amount: "10000000000",
    intervalBlocks: "30",
    firstNotBefore: "160",
    totalRuns: "3",
    reward: "6100000000",
    creatorNonce: "9",
  });
  const build = buildRecurringCreation({
    deployment: registered,
    ...value,
    creationFee: RECURRING_FEE,
  });
  const apiArtifact = artifact({
    operation: "create_recurring_job",
    transaction: build.transaction,
    intent: build.intent,
    protocolIntentHash: build.intentHash,
    quote: build.quote,
  });
  const inputCapacity = build.quote.maximumLockedTotal + 10_000_000_000n;
  const completed = completedTransaction(build.transaction, owner, inputCapacity, 1_600n);
  const model = await verifyCreationReview(
    { operation: "create_recurring_job", value },
    apiArtifact,
    completed,
    `0x${"88".repeat(32)}`,
    {
      deployment: registered,
      hashLock: lockHasher(owner, ownerLockHash),
      ownerInputLockHashes: new Set([ownerLockHash]),
      resolveInput: async () => ({ capacity: inputCapacity, lockHash: ownerLockHash }),
    },
  );

  assert.deepEqual(
    {
      title: model.title,
      summary: model.summary,
      timing: model.timing,
      amounts: model.amounts,
      fee: model.fee,
      maximumFee: model.maximumFee,
      change: model.change,
      recovery: model.recovery,
      immutableTerms: model.immutableTerms,
      network: model.network,
    },
    {
      title: "Recurring distribution",
      summary: "100 CKB will be available to the fixed recipient on each of 3 eligible runs.",
      timing:
        "Earliest at block 160, roughly 10 minutes after the API snapshot if blocks average 10 seconds. Actual block timing varies.",
      amounts: [
        { label: "Payment per run", value: "100 CKB" },
        { label: "Executions", value: "3" },
        { label: "Executor reward per run", value: "61 CKB" },
        { label: "Total capacity locked", value: "864 CKB" },
        { label: "Recoverable residual", value: "381 CKB" },
      ],
      fee: "0.000016 CKB (1600 shannons), paid by the connected owner",
      maximumFee: "0.000016 CKB (1600 shannons)",
      change: "99.999984 CKB across 1 owner change output",
      recovery:
        "After the final run, remaining Job Cell capacity returns to the connected owner. The owner also retains cancellation and recovery authority.",
      immutableTerms: [
        `Recipient lock ${ownerLockHash}`,
        "10000000000 shannons per run for 3 runs",
        "First block 160, every 30 blocks",
        "6100000000 shannons executor reward per run",
        `Owner and final refund lock ${ownerLockHash}`,
      ],
      network: "ckb_dev",
    },
  );
});

test("review rejects every changed policy field, owner input, output, and fee mutation", async () => {
  const registered = await deployment();
  const owner = ownerScript(registered);
  const ownerLockHash = parseHash32(`0x${"44".repeat(32)}`);
  const value = parseRecurringCreationRequest({
    ownerLockHash,
    recipientLockHash: ownerLockHash,
    amount: "10000000000",
    intervalBlocks: "30",
    firstNotBefore: "160",
    totalRuns: "2",
    reward: "6100000000",
    creatorNonce: "10",
  });
  const build = buildRecurringCreation({
    deployment: registered,
    ...value,
    creationFee: RECURRING_FEE,
  });
  const apiArtifact = artifact({
    operation: "create_recurring_job",
    transaction: build.transaction,
    intent: build.intent,
    protocolIntentHash: build.intentHash,
    quote: build.quote,
  });
  const inputCapacity = build.quote.maximumLockedTotal + 10_000_000_000n;
  const completed = completedTransaction(build.transaction, owner, inputCapacity, 1_600n);
  const request = { operation: "create_recurring_job", value } as const;
  const context = {
    deployment: registered,
    hashLock: lockHasher(owner, ownerLockHash),
    ownerInputLockHashes: new Set([ownerLockHash]),
    resolveInput: async () => ({ capacity: inputCapacity, lockHash: ownerLockHash }),
  };

  await assert.rejects(
    verifyCreationReview(
      request,
      { ...apiArtifact, policyCriticalHash: "0".repeat(64) },
      completed,
      INPUT_HASH,
      context,
    ),
    /policy hash/,
  );
  await assert.rejects(
    verifyCreationReview(
      request,
      withExpiry(apiArtifact, {
        afterBlock: "131",
        condition: "canonical_snapshot_window",
      }),
      completed,
      INPUT_HASH,
      context,
    ),
    /bounded canonical snapshot window/,
  );
  await assert.rejects(
    verifyCreationReview(
      request,
      withExpiry(apiArtifact, {
        afterBlock: "130",
        condition: "tip_change_before_signing",
      }),
      completed,
      INPUT_HASH,
      context,
    ),
    /bounded canonical snapshot window/,
  );
  const changedQuote = {
    ...apiArtifact.quote,
    maximumLockedTotal: (build.quote.maximumLockedTotal + 1n).toString(),
    maximumOwnerFunding: (build.quote.maximumOwnerFunding + 1n).toString(),
  };
  await assert.rejects(
    verifyCreationReview(
      request,
      withQuote(apiArtifact, changedQuote),
      completed,
      INPUT_HASH,
      context,
    ),
    /quote maximumLockedTotal/,
  );
  for (const [field, changed] of [
    ["ownerLockHash", `0x${"55".repeat(32)}`],
    ["recipientLockHash", `0x${"66".repeat(32)}`],
    ["amount", "10000000001"],
    ["intervalBlocks", "31"],
    ["firstNotBefore", "161"],
    ["totalRuns", "3"],
    ["reward", "6100000001"],
  ] as const) {
    await assert.rejects(
      verifyCreationReview(
        request,
        withIntent(apiArtifact, { ...apiArtifact.intent, [field]: changed }),
        completed,
        INPUT_HASH,
        context,
      ),
      /recurring intent cannot be reproduced/,
      field,
    );
  }
  await assert.rejects(
    verifyCreationReview(request, apiArtifact, completed, INPUT_HASH, {
      ...context,
      resolveInput: async () => ({ capacity: inputCapacity, lockHash: `0x${"99".repeat(32)}` }),
    }),
    /outside the connected owner lock/,
  );
  const changedOutput: UnsignedDeadlineTransaction = {
    ...completed,
    outputs: [
      {
        ...completed.outputs[0]!,
        capacity: `0x${(BigInt(completed.outputs[0]!.capacity) + 1n).toString(16)}`,
      },
      ...completed.outputs.slice(1),
    ],
  };
  await assert.rejects(
    verifyCreationReview(request, apiArtifact, changedOutput, INPUT_HASH, context),
    /changed the recurring Job Cell output/,
  );
  const excessiveFee = completedTransaction(build.transaction, owner, inputCapacity, 1_601n);
  await assert.rejects(
    verifyCreationReview(request, apiArtifact, excessiveFee, INPUT_HASH, context),
    /fee exceeds the reviewed maximum/,
  );
});

test("typed deadline transaction exposes outcome and recovery commitments", async () => {
  const registered = await deployment();
  const owner = ownerScript(registered);
  const ownerLockHash = parseHash32(`0x${"44".repeat(32)}`);
  const value = parseDeadlineCreationRequest({
    pledges: [
      {
        outPoint: { txHash: INPUT_HASH, index: "0" },
        refundLockHash: ownerLockHash,
        amount: "10000000000",
      },
    ],
    target: "15000000000",
    deadlineBlock: "220",
    successLockHash: parseHash32(`0x${"55".repeat(32)}`),
    cancelLockHash: ownerLockHash,
    reward: "6100000000",
    creatorNonce: "11",
  });
  const build = buildDeadlineCreation({
    deployment: registered,
    ...value,
    creationFee: DEADLINE_FEE,
  });
  const apiArtifact = artifact({
    operation: "create_deadline_job",
    transaction: build.transaction,
    intent: build.intent,
    protocolIntentHash: build.intentHash,
    quote: build.quote,
  });
  const inputCapacity = build.quote.maximumLockedTotal + 10_000_000_000n;
  const completed = completedTransaction(build.transaction, owner, inputCapacity, 1_800n);
  const model = await verifyCreationReview(
    { operation: "create_deadline_job", value },
    apiArtifact,
    completed,
    `0x${"aa".repeat(32)}`,
    {
      deployment: registered,
      hashLock: lockHasher(owner, ownerLockHash),
      ownerInputLockHashes: new Set([ownerLockHash]),
      resolveInput: async () => ({ capacity: inputCapacity, lockHash: ownerLockHash }),
    },
  );
  assert.equal(model.title, "Deadline finalization");
  assert.equal(model.amounts[0]?.value, "100 CKB");
  assert.equal(model.amounts[1]?.value, "150 CKB");
  assert.match(model.recovery, new RegExp(ownerLockHash));
  assert.match(model.timing, /block 220/);
});

test("review uses CCC completion without invoking a wallet signature", async () => {
  const [provider, review] = await Promise.all([
    readFile(new URL("../ccc/ccc-provider.tsx", import.meta.url), "utf8"),
    readFile(new URL("./creation-review.tsx", import.meta.url), "utf8"),
  ]);
  const completionStart = provider.indexOf("completeForReview:");
  const completionEnd = provider.indexOf("detailsStatus:", completionStart);
  const completion = provider.slice(completionStart, completionEnd);
  assert.match(completion, /await completed\.completeFeeBy\(currentSigner, undefined, undefined,/);
  assert.match(completion, /maxFeeRate: REVIEW_FEE_RATE_MAXIMUM/);
  assert.match(provider, /getHeaderByNumber\(0\)/);
  assert.doesNotMatch(completion, /sign(?:Only)?Transaction\(/);
  assert.match(review, /reviewStateError/);
  assert.match(review, /freezeReviewedTransaction\(completed\.transaction\)/);
  assert.match(review, /connected wallet network does not match the reviewed deployment/i);
});

test("technical review details render bigint values as exact decimal strings", () => {
  assert.equal(
    reviewTechnicalDetailsJson({ capacity: 10_000_000_000n }),
    '{\n  "capacity": "10000000000"\n}',
  );
});
