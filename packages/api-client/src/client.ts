import type { operations } from "./generated/openapi.ts";

type OperationName = keyof operations;

export type ApiRequestBody<Name extends OperationName> = operations[Name] extends {
  readonly requestBody: {
    readonly content: { readonly "application/json": infer Body };
  };
}
  ? Body
  : never;

export type ApiQuery<Name extends OperationName> = operations[Name] extends {
  readonly parameters: { readonly query?: infer Query };
}
  ? Query
  : never;

type ApiResponse<Name extends OperationName, Status extends number> = operations[Name] extends {
  readonly responses: infer Responses;
}
  ? Status extends keyof Responses
    ? Responses[Status] extends {
        readonly content: { readonly "application/json": infer Body };
      }
      ? Body
      : unknown
    : never
  : never;

export type ApiSuccess<Name extends OperationName> =
  ApiResponse<Name, 200> extends never ? ApiResponse<Name, 201> : ApiResponse<Name, 200>;

export type ApiJobList = ApiSuccess<"JobsController_list">;
export type ApiJob = ApiSuccess<"JobsController_detail">;
export type ApiJobEvents = ApiSuccess<"JobEventsController_list">;
export type ApiJobQuote = ApiSuccess<"JobQuoteController_get">;
export type ApiTemplates = ApiSuccess<"TemplatesController_list">;
export type ApiTransactionBuild = ApiSuccess<"TransactionController_createDeadline">;
export type ApiTransactionValidation = ApiSuccess<"TransactionController_validateSigned">;
export type ApiAuthChallenge = ApiSuccess<"AuthController_issue">;
export type ApiAuthSession = ApiSuccess<"AuthController_verify">;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class ApiClientError extends Error {
  readonly body: unknown;
  readonly status: number;

  constructor(status: number, body: unknown) {
    super(`CKB Automata API request failed with status ${status}`);
    this.name = "ApiClientError";
    this.status = status;
    this.body = body;
  }
}

function appendQuery(url: URL, query: unknown): void {
  if (typeof query !== "object" || query === null) return;
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
}

export class AutomataApiClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  live(): Promise<ApiSuccess<"HealthController_live">> {
    return this.#request("v1/health/live");
  }

  ready(): Promise<ApiSuccess<"HealthController_ready">> {
    return this.#request("v1/health/ready");
  }

  network(): Promise<ApiSuccess<"NetworkMetadataController_get">> {
    return this.#request("v1/network");
  }

  templates(): Promise<ApiTemplates> {
    return this.#request("v1/templates");
  }

  issueAuthChallenge(body: ApiRequestBody<"AuthController_issue">): Promise<ApiAuthChallenge> {
    return this.#post("v1/auth/challenge", body);
  }

  verifyAuthChallenge(body: ApiRequestBody<"AuthController_verify">): Promise<ApiAuthSession> {
    return this.#post("v1/auth/verify", body);
  }

  getAuthSession(sessionToken: string): Promise<ApiSuccess<"AuthController_current">> {
    return this.#request("v1/auth/session", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
  }

  listJobs(query?: ApiQuery<"JobsController_list">): Promise<ApiJobList> {
    return this.#request("v1/jobs", { query });
  }

  getJob(jobId: string): Promise<ApiJob> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}`);
  }

  listAccountJobs(
    lockHash: string,
    query?: ApiQuery<"AccountJobsController_list">,
  ): Promise<ApiSuccess<"AccountJobsController_list">> {
    return this.#request(`v1/accounts/${encodeURIComponent(lockHash)}/jobs`, { query });
  }

  listJobEvents(
    jobId: string,
    query?: ApiQuery<"JobEventsController_list">,
  ): Promise<ApiJobEvents> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}/events`, { query });
  }

  getJobQuote(jobId: string): Promise<ApiJobQuote> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}/quote`);
  }

  createDeadlineJob(
    body: ApiRequestBody<"TransactionController_createDeadline">,
  ): Promise<ApiTransactionBuild> {
    return this.#post("v1/transactions/create-deadline-job", body);
  }

  createRecurringJob(
    body: ApiRequestBody<"TransactionController_createRecurring">,
  ): Promise<ApiSuccess<"TransactionController_createRecurring">> {
    return this.#post("v1/transactions/create-recurring-job", body);
  }

  cancelJob(
    body: ApiRequestBody<"TransactionController_cancel">,
  ): Promise<ApiSuccess<"TransactionController_cancel">> {
    return this.#post("v1/transactions/cancel-job", body);
  }

  recoverJob(
    body: ApiRequestBody<"TransactionController_recover">,
  ): Promise<ApiSuccess<"TransactionController_recover">> {
    return this.#post("v1/transactions/recover-job", body);
  }

  topUpJob(
    body: ApiRequestBody<"TransactionController_topUp">,
  ): Promise<ApiSuccess<"TransactionController_topUp">> {
    return this.#post("v1/transactions/top-up-job", body);
  }

  validateSigned(
    body: ApiRequestBody<"TransactionController_validateSigned">,
  ): Promise<ApiTransactionValidation> {
    return this.#post("v1/transactions/validate-signed", body);
  }

  #post<Result>(path: string, body: unknown): Promise<Result> {
    return this.#request(path, { body, method: "POST" });
  }

  async #request<Result>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly method?: "POST";
      readonly query?: unknown;
    } = {},
  ): Promise<Result> {
    const url = new URL(path, this.#baseUrl);
    appendQuery(url, options.query);
    const response = await this.#fetch(url, {
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) throw new ApiClientError(response.status, body);
    return body as Result;
  }
}

export function createApiClient(options: ApiClientOptions): AutomataApiClient {
  return new AutomataApiClient(options);
}
