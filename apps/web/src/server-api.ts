import { createApiClient, type AutomataApiClient } from "@ckb-automata/api-client";

import { parseWebEnvironment } from "./environment.ts";

export function createServerApiClient(
  input: Readonly<Record<string, string | undefined>> = process.env,
): AutomataApiClient {
  const environment = parseWebEnvironment(input);
  return createApiClient({ baseUrl: environment.apiUrl });
}
