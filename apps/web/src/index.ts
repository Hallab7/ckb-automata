import { WORKSPACE_NAME } from "@ckb-automata/core";

export {
  ApiClientError,
  AutomataApiClient,
  createApiClient,
  type ApiAuthChallenge,
  type ApiAuthSession,
  type ApiClientOptions,
  type ApiJob,
  type ApiJobEvents,
  type ApiJobList,
  type ApiJobQuote,
  type ApiNotificationPreferences,
  type ApiTemplates,
  type ApiTransactionBuild,
  type ApiTransactionValidation,
  type ApiWebhookDelivery,
  type ApiWebhookList,
  type ApiWebhookRegistration,
} from "@ckb-automata/api-client";

export const WEB_APP_ID = `${WORKSPACE_NAME}:web` as const;

export { parseWebEnvironment, type WebEnvironment, type WebNetwork } from "./environment.ts";
export { createServerApiClient } from "./server-api.ts";
