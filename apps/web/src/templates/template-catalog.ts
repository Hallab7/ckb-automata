export type TemplateCapability = "demo" | "executable" | "research";

export interface TemplateCatalogItem {
  readonly action: { readonly href: string; readonly label: string };
  readonly approval: string;
  readonly capability: TemplateCapability;
  readonly description: string;
  readonly id: "deadline" | "demo" | "nervdao" | "recurring";
  readonly name: string;
  readonly recoverability: string;
  readonly risk: string;
}

export const TEMPLATE_CATALOG: readonly TemplateCatalogItem[] = Object.freeze([
  Object.freeze({
    action: Object.freeze({ href: "/automations/new/deadline", label: "Start setup" }),
    approval:
      "The owner wallet signs creation. An executor may finalize only after the committed block.",
    capability: "executable",
    description: "Finalize a test campaign into its committed release or refund outcome.",
    id: "deadline",
    name: "Deadline finalization",
    recoverability: "Owner-authorized cancel or recovery returns the complete Job Cell value.",
    risk: "Funds remain locked until finalization or an owner exit is confirmed on testnet.",
  }),
  Object.freeze({
    action: Object.freeze({ href: "/automations/new/recurring", label: "Start setup" }),
    approval:
      "The owner wallet signs once. Each run pays only the committed recipient and executor.",
    capability: "executable",
    description: "Pay one fixed recipient on a block interval for a bounded number of runs.",
    id: "recurring",
    name: "Recurring distribution",
    recoverability: "The owner may cancel a live job or recover a stalled or unsupported job.",
    risk: "Capacity stays locked across runs and must cover payouts, rewards, and occupied capacity.",
  }),
  Object.freeze({
    action: Object.freeze({ href: "/demo", label: "Open guided demo" }),
    approval: "No wallet approval is requested by the fixture-backed walkthrough.",
    capability: "demo",
    description: "Inspect guided fixture scenarios without presenting them as live chain evidence.",
    id: "demo",
    name: "Guided scenarios",
    recoverability: "No funds are locked, so there is no cancellation or recovery transaction.",
    risk: "Demo records are illustrative and do not prove public testnet execution.",
  }),
  Object.freeze({
    action: Object.freeze({ href: "/research/nervdao", label: "Read research" }),
    approval: "No wallet signature, vault deposit, or automation schedule is available.",
    capability: "research",
    description: "Explore the proposed NervDAO Cycle Guard and its two withdrawal phases.",
    id: "nervdao",
    name: "NervDAO Cycle Guard",
    recoverability:
      "No funds are locked. A future design requires a separately audited vault and exit path.",
    risk: "DAO maturity handling and vault security are not implemented or testnet-proven.",
  }),
]);
