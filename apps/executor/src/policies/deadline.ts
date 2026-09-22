import type { ExecutorAdapterRegistration } from "../adapter.ts";

export const DEADLINE_EXECUTOR_REGISTRATION = Object.freeze({
  id: "deadline-v1",
  policy: "deadline",
  supports: (policy) => policy.kind === "deadline",
} satisfies ExecutorAdapterRegistration);
