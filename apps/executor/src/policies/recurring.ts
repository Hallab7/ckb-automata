import type { ExecutorAdapterRegistration } from "../adapter.ts";

export const RECURRING_EXECUTOR_REGISTRATION = Object.freeze({
  id: "recurring-v1",
  policy: "recurring",
  supports: (policy) => policy.kind === "recurring",
} satisfies ExecutorAdapterRegistration);
