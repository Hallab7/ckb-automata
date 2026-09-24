import { ApiClientError } from "@ckb-automata/api-client";

export type RequestSurface = "activity" | "dashboard" | "detail";
export type DetailFailureState = "error" | "not_found";

const copy = {
  activity: {
    conflict: "The canonical checkpoint advanced. Refresh the feed before loading more.",
    generic: "The activity feed could not be loaded.",
    rejected: "The API rejected this activity query.",
    transport: "The testnet API could not be reached. Check the connection and retry.",
    unavailable: "The testnet activity index is temporarily unavailable.",
  },
  dashboard: {
    conflict: "The index advanced during pagination. Refresh the list to continue.",
    generic: "The automation list could not be loaded.",
    rejected: "The API rejected this automation query.",
    transport: "The testnet API could not be reached. Check the API connection and retry.",
    unavailable: "The testnet job index is temporarily unavailable.",
  },
  detail: {
    conflict: "The index advanced while the timeline was loading. Refresh and retry.",
    generic: "The automation detail could not be loaded.",
    notFound: "The automation was not found at the current checkpoint.",
    transport: "The testnet API could not be reached. Check the API connection and retry.",
    unavailable: "The testnet job index is temporarily unavailable.",
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
