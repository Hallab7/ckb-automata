export type DemoScenarioTone = "danger" | "info" | "success" | "warning";

export interface DemoScenario {
  readonly facts: readonly Readonly<{ label: string; value: string }>[];
  readonly id: "ready" | "recovery" | "scheduled";
  readonly name: string;
  readonly status: string;
  readonly summary: string;
  readonly timeline: readonly Readonly<{ detail: string; label: string; state: string }>[];
  readonly tone: DemoScenarioTone;
  readonly walkthrough: readonly Readonly<{ body: string; label: string; title: string }>[];
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = Object.freeze([
  {
    id: "scheduled",
    name: "Scheduled payout",
    status: "Waiting",
    summary: "A recurring contributor payout is funded and waiting for its next scheduled time.",
    tone: "info",
    facts: Object.freeze([
      { label: "Template", value: "Recurring distribution" },
      { label: "Recipient amount", value: "100 CKB" },
      { label: "Next execution", value: "Sep 27, 2026, 10:30 AM UTC" },
      { label: "Runs remaining", value: "4" },
    ]),
    timeline: Object.freeze([
      { detail: "Policy and funding recorded", label: "Automation created", state: "Confirmed" },
      { detail: "Starts in about 47 minutes", label: "Schedule observed", state: "Waiting" },
    ]),
    walkthrough: Object.freeze([
      {
        body: "The owner committed a fixed recipient, amount, cadence, run count, and executor reward.",
        label: "Policy",
        title: "Review immutable intent",
      },
      {
        body: "Capacity covers all remaining payouts, executor rewards, and the terminal owner return.",
        label: "Funding",
        title: "Check committed funds",
      },
      {
        body: "The executor cannot spend before the next scheduled time encoded in the job.",
        label: "Schedule",
        title: "Wait for the scheduled time",
      },
    ]),
  },
  {
    id: "ready",
    name: "Ready to execute",
    status: "Processing",
    summary:
      "A scheduled payment reached its committed time and is being processed by the automation service.",
    tone: "success",
    facts: Object.freeze([
      { label: "Template", value: "Deadline finalization" },
      { label: "Pledged value", value: "480 CKB" },
      { label: "Target", value: "400 CKB" },
      { label: "Outcome", value: "Recipient settlement" },
    ]),
    timeline: Object.freeze([
      {
        detail: "Target crossed before the deadline",
        label: "Campaign funded",
        state: "Confirmed",
      },
      { detail: "Committed schedule reached", label: "Payment processing", state: "Processing" },
      { detail: "No transaction has been submitted", label: "Executor attempt", state: "Pending" },
    ]),
    walkthrough: Object.freeze([
      {
        body: "The finalization branch follows pledged capacity and the target committed at creation.",
        label: "Outcome",
        title: "Confirm the objective branch",
      },
      {
        body: "Any executor may construct the constrained settlement and claim only the fixed reward.",
        label: "Execution",
        title: "Inspect permissionless execution",
      },
      {
        body: "A submitted transaction remains pending until canonical inclusion and confirmation depth are observed.",
        label: "Evidence",
        title: "Separate submission from confirmation",
      },
    ]),
  },
  {
    id: "recovery",
    name: "Owner recovery",
    status: "Recovery required",
    summary:
      "A terminal operational failure left a live job that the owner can recover without the service.",
    tone: "danger",
    facts: Object.freeze([
      { label: "Template", value: "Recurring distribution" },
      { label: "Recoverable value", value: "93 CKB" },
      { label: "Failure", value: "Unsupported metadata" },
      { label: "Owner action", value: "Exact refund" },
    ]),
    timeline: Object.freeze([
      { detail: "Job remains live and funded", label: "Execution stopped", state: "Failed" },
      {
        detail: "Owner-authenticated refund available",
        label: "Recovery detected",
        state: "Action required",
      },
    ]),
    walkthrough: Object.freeze([
      {
        body: "The job outpoint is still live, so no prior executor or owner transaction has won the race.",
        label: "Freshness",
        title: "Verify the live outpoint",
      },
      {
        body: "The recovery transaction requires a valid co-spent owner input and preserves the exact refund.",
        label: "Authorization",
        title: "Review owner authentication",
      },
      {
        body: "The wallet receives the reviewed transaction only after the chain tip and input are refreshed.",
        label: "Approval",
        title: "Approve the exact transaction",
      },
    ]),
  },
]);
