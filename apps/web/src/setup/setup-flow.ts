export const SETUP_STEPS = [
  { id: "template", label: "Template" },
  { id: "details", label: "Details" },
  { id: "timing", label: "Timing" },
  { id: "funding", label: "Funding" },
  { id: "review", label: "Review" },
  { id: "approval", label: "Wallet approval" },
  { id: "result", label: "Result" },
] as const;

export const DEADLINE_SETUP_STEPS = SETUP_STEPS.filter((step) => step.id !== "funding");

export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];
export type SetupTemplateId = "deadline" | "recurring";
export type SetupDraft = Readonly<Record<string, string>>;
export type SetupErrors = Readonly<Record<string, string>>;

export const FIRST_SETUP_STEP: SetupStepId = "details";

export function parseSetupStep(value: string | null): SetupStepId {
  return value !== "template" && SETUP_STEPS.some((step) => step.id === value)
    ? (value as SetupStepId)
    : FIRST_SETUP_STEP;
}

export function setupStepUrl(pathname: string, step: SetupStepId): string {
  return step === FIRST_SETUP_STEP ? pathname : `${pathname}?step=${encodeURIComponent(step)}`;
}

export function setupStorageKey(template: SetupTemplateId, storageId?: string): string {
  return `ckb-automata.setup.${template}${storageId === undefined ? "" : `.${storageId}`}`;
}

export function parseStoredDraft(value: string | null): SetupDraft | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((field) => typeof field !== "string")
    ) {
      return undefined;
    }
    return Object.freeze({ ...(parsed as Record<string, string>) });
  } catch {
    return undefined;
  }
}

export function stepIndex(
  step: SetupStepId,
  steps: readonly Readonly<{ id: SetupStepId; label: string }>[] = SETUP_STEPS,
): number {
  return steps.findIndex((candidate) => candidate.id === step);
}
