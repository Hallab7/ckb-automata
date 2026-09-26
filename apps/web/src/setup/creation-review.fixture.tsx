import { ReviewSummary } from "./creation-review.tsx";
import type { CreationReviewModel } from "./review-model.ts";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const ADDRESS = "ckt1qfixturepaymentrecipient000000000000000000000000000000000000";

const MODEL: CreationReviewModel = Object.freeze({
  jobId: HASH_A,
  operation: "create_recurring_job",
  title: "Recurring distribution",
  summary: "100 CKB will be available to the fixed recipient on each of 3 eligible runs.",
  network: "ckb_testnet",
  snapshotBlock: "14999940",
  snapshotHash: HASH_A,
  genesisHash: HASH_B,
  manifestSha256: "33".repeat(32),
  timing:
    "Earliest at block 15000000, roughly 10 minutes after the API snapshot if blocks average 10 seconds. Actual block timing varies.",
  amounts: Object.freeze([
    { label: "Payment per run", value: "100 CKB" },
    { label: "Executions", value: "3" },
    { label: "Executor reward per run", value: "61 CKB" },
    { label: "Total capacity locked", value: "864 CKB" },
    { label: "Recoverable residual", value: "381 CKB" },
  ]),
  fee: "0.0000124 CKB (1240 shannons), paid by the connected owner",
  maximumFee: "0.000016 CKB (1600 shannons)",
  change: "135.9999876 CKB across 1 owner change output",
  recovery:
    "After the final run, remaining Job Cell capacity returns to the connected owner. The owner also retains cancellation and recovery authority.",
  immutableTerms: Object.freeze([
    `Recipient lock ${HASH_A}`,
    "10000000000 shannons per run for 3 runs",
    "First block 15000000, every 100 blocks",
    "6100000000 shannons executor reward per run",
    `Owner and final refund lock ${HASH_B}`,
  ]),
  warnings: Object.freeze([
    "This transaction is for a non-mainnet deployment.",
    "Block estimates are approximate; eligibility does not guarantee immediate execution or confirmation.",
    "Changing any input, committed output, policy payload, fee, or change requires a new review.",
  ]),
  intentHash: HASH_A,
  policyCriticalHash: "44".repeat(32),
  transactionHash: HASH_B,
  technicalDetails: Object.freeze({
    normalizedIntent: {
      version: 1,
      recipientLockHash: HASH_A,
      ownerLockHash: HASH_B,
      amount: "10000000000",
      intervalBlocks: "100",
      firstNotBefore: "15000000",
      totalRuns: "3",
      reward: "6100000000",
    },
    completedTransaction: {
      inputs: [{ previousOutput: { txHash: HASH_A, index: "0x0" }, since: "0x0" }],
      outputs: [
        { capacity: "0x141dd76000", lock: { codeHash: HASH_A, hashType: "type", args: "0x" } },
      ],
      witnesses: ["0x10000000100000001000000010000000"],
    },
  }),
});

export function CreationReviewFixture() {
  return (
    <main className="app-page" aria-labelledby="fixture-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">CKB Pudge Testnet</p>
          <h1 id="fixture-title">Transaction review fixture</h1>
        </div>
      </header>
      <div className="setup-step">
        <ReviewSummary draft={{ recipientAddress: ADDRESS }} model={MODEL} />
      </div>
    </main>
  );
}
