import { hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import type { RegisteredDeployment } from "./deployment-registry.ts";
import { inspectJobData, type JobInspectionResult, type ScriptIdentity } from "./job-inspection.ts";

type BinaryStatus = JobInspectionResult["status"];

export interface SdkConformanceCaseResult {
  readonly id: string;
  readonly jsonMatchesBinary: boolean;
  readonly binaryStatus: BinaryStatus;
  readonly transactionValid: boolean;
}

export type SdkConformanceResult =
  | { readonly status: "ok"; readonly cases: readonly SdkConformanceCaseResult[] }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

interface ConformanceCase {
  readonly id: string;
  readonly policy: "deadline" | "recurring";
  readonly policy_args: string;
  readonly json: {
    readonly job_id: string;
    readonly sequence: string;
    readonly remaining_runs: string;
    readonly policy: string;
  };
  readonly binary: string;
  readonly transaction: string;
  readonly expected: {
    readonly json_matches_binary: boolean;
    readonly binary_status: BinaryStatus;
    readonly transaction_valid: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFixture(
  value: unknown,
): { version: 1; cases: readonly ConformanceCase[] } | undefined {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["cases"])) return;
  const cases: ConformanceCase[] = [];
  for (const candidate of value["cases"]) {
    if (!isRecord(candidate) || !isRecord(candidate["json"]) || !isRecord(candidate["expected"])) {
      return;
    }
    const json = candidate["json"];
    const expected = candidate["expected"];
    if (
      typeof candidate["id"] !== "string" ||
      (candidate["policy"] !== "deadline" && candidate["policy"] !== "recurring") ||
      typeof candidate["policy_args"] !== "string" ||
      (candidate["policy"] === "recurring" && candidate["policy_args"] !== "0x") ||
      (candidate["policy"] === "deadline" && !/^0x[0-9a-f]{64}$/.test(candidate["policy_args"])) ||
      typeof candidate["binary"] !== "string" ||
      typeof candidate["transaction"] !== "string" ||
      typeof json["job_id"] !== "string" ||
      typeof json["sequence"] !== "string" ||
      typeof json["remaining_runs"] !== "string" ||
      typeof json["policy"] !== "string" ||
      typeof expected["json_matches_binary"] !== "boolean" ||
      !["ok", "malformed", "unsupported_version", "invalid_job"].includes(
        String(expected["binary_status"]),
      ) ||
      typeof expected["transaction_valid"] !== "boolean"
    ) {
      return;
    }
    cases.push(candidate as unknown as ConformanceCase);
  }
  return { version: 1, cases };
}

function policyScript(
  deployment: RegisteredDeployment,
  fixtureCase: ConformanceCase,
): ScriptIdentity {
  const contract = fixtureCase.policy === "deadline" ? "deadline-policy" : "recurring-policy";
  return Object.freeze({
    ...deployment.contracts[contract].script,
    args: fixtureCase.policy_args as `0x${string}`,
  });
}

function jsonMatches(caseFixture: ConformanceCase, inspection: JobInspectionResult): boolean {
  if (inspection.status !== "ok") return false;
  return (
    caseFixture.json.job_id === inspection.job.jobId &&
    caseFixture.json.sequence === inspection.job.sequence.toString() &&
    caseFixture.json.remaining_runs === inspection.job.remainingRuns.toString() &&
    caseFixture.json.policy === inspection.policy.kind
  );
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function transactionValid(transaction: string, binary: string): boolean {
  try {
    const transactionBytes = hexToBytes(transaction);
    const binaryBytes = hexToBytes(binary);
    if (transactionBytes.length < 4) return false;
    const declared = new DataView(
      transactionBytes.buffer,
      transactionBytes.byteOffset,
      transactionBytes.byteLength,
    ).getUint32(0, true);
    return declared === transactionBytes.length && contains(transactionBytes, binaryBytes);
  } catch {
    return false;
  }
}

export function validateSdkConformanceFixture(
  raw: unknown,
  deployment: RegisteredDeployment,
): SdkConformanceResult {
  const fixture = parseFixture(raw);
  if (!fixture) return Object.freeze({ status: "invalid", issues: ["fixture shape is invalid"] });
  const ids = new Set<string>();
  const issues: string[] = [];
  const results: SdkConformanceCaseResult[] = [];
  for (const fixtureCase of fixture.cases) {
    if (ids.has(fixtureCase.id)) issues.push(`${fixtureCase.id}: duplicate case id`);
    ids.add(fixtureCase.id);
    const inspection = inspectJobData(fixtureCase.binary, {
      manifest: deployment.manifest,
      expectedGenesisHash: deployment.genesisHash,
      policyScript: policyScript(deployment, fixtureCase),
    });
    const result = Object.freeze({
      id: fixtureCase.id,
      jsonMatchesBinary: jsonMatches(fixtureCase, inspection),
      binaryStatus: inspection.status,
      transactionValid: transactionValid(fixtureCase.transaction, fixtureCase.binary),
    });
    if (result.jsonMatchesBinary !== fixtureCase.expected.json_matches_binary) {
      issues.push(`${fixtureCase.id}: JSON expectation drifted`);
    }
    if (result.binaryStatus !== fixtureCase.expected.binary_status) {
      issues.push(`${fixtureCase.id}: binary expectation drifted`);
    }
    if (result.transactionValid !== fixtureCase.expected.transaction_valid) {
      issues.push(`${fixtureCase.id}: transaction expectation drifted`);
    }
    results.push(result);
  }
  const hasJsonCoverage =
    results.some((value) => value.jsonMatchesBinary) &&
    results.some((value) => !value.jsonMatchesBinary);
  const hasBinaryCoverage =
    results.some((value) => value.binaryStatus === "ok") &&
    results.some((value) => value.binaryStatus !== "ok");
  const hasTransactionCoverage =
    results.some((value) => value.transactionValid) &&
    results.some((value) => !value.transactionValid);
  if (!hasJsonCoverage) issues.push("suite must cover matching and mismatching JSON");
  if (!hasBinaryCoverage) issues.push("suite must cover valid and invalid binaries");
  if (!hasTransactionCoverage) issues.push("suite must cover valid and invalid transactions");
  return issues.length === 0
    ? Object.freeze({ status: "ok", cases: Object.freeze(results) })
    : Object.freeze({ status: "invalid", issues: Object.freeze(issues) });
}
