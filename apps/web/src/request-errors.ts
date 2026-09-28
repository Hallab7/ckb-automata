import { ApiClientError } from "@ckb-automata/api-client";

export type RequestSurface = "activity" | "dashboard" | "detail";
export type DetailFailureState = "error" | "not_found";

const copy = {
  activity: {
    conflict: "Something went wrong. Please try again.",
    generic: "Something went wrong. Please try again.",
    rejected: "Something went wrong. Please try again.",
    transport: "Something went wrong. Please try again.",
    unavailable: "Something went wrong. Please try again.",
  },
  dashboard: {
    conflict: "Something went wrong. Please try again.",
    generic: "Something went wrong. Please try again.",
    rejected: "Something went wrong. Please try again.",
    transport: "Something went wrong. Please try again.",
    unavailable: "Something went wrong. Please try again.",
  },
  detail: {
    conflict: "Something went wrong. Please try again.",
    generic: "Something went wrong. Please try again.",
    notFound: "The automation was not found at the current checkpoint.",
    transport: "Something went wrong. Please try again.",
    unavailable: "Something went wrong. Please try again.",
  },
} as const;

export function requestErrorMessage(
  surface: Exclude<RequestSurface, "detail">,
  error: unknown,
): string {
  const messages = copy[surface];
  if (error instanceof ApiClientError) {
    if (error.status === 409) return messages.conflict;
    if (error.status >= 500) return messages.unavailable;
    return messages.rejected;
  }
  return error instanceof TypeError ? messages.transport : messages.generic;
}

export function detailRequestError(error: unknown): {
  readonly message: string;
  readonly state: DetailFailureState;
} {
  if (error instanceof ApiClientError) {
    if (error.status === 404) return { message: copy.detail.notFound, state: "not_found" };
    if (error.status === 409) return { message: copy.detail.conflict, state: "error" };
    if (error.status >= 500) return { message: copy.detail.unavailable, state: "error" };
  }
  return {
    message: error instanceof TypeError ? copy.detail.transport : copy.detail.generic,
    state: "error",
  };
}
