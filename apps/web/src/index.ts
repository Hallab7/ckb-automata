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
  type ApiTemplates,
  type ApiTransactionBuild,
  type ApiTransactionValidation,
} from "@ckb-automata/api-client";

export const WEB_APP_ID = `${WORKSPACE_NAME}:web` as const;
