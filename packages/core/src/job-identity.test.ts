import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deriveJobId, type JobIdentityInput } from "./job-identity.ts";

interface Fixture {
  genesis_hash: string;
  protocol_version: number;
  creation_commitment: string;
  anchor: { kind: "output_index"; output_index: string };
  creator_nonce: string;
  policy_script_hash: string;
  expected_job_id: string;
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));
}

function hexString(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString("hex")}`;
}

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/job_identity_v1.json", import.meta.url),
      "utf8",
    ),
  ) as Fixture;
}

function toInput(fixture: Fixture): JobIdentityInput {
  return {
    genesisHash: hex(fixture.genesis_hash),
    protocolVersion: fixture.protocol_version,
    creationCommitment: hex(fixture.creation_commitment),
    anchor: { kind: "output_index", outputIndex: BigInt(fixture.anchor.output_index) },
    creatorNonce: BigInt(fixture.creator_nonce),
    policyScriptHash: hex(fixture.policy_script_hash),
  };
}

test("TypeScript job identity matches the cross-language fixture", async () => {
  const fixture = await loadFixture();
  assert.equal(hexString(deriveJobId(toInput(fixture))), fixture.expected_job_id);
});

test("identity changes with every collision boundary", async () => {
  const baseline = toInput(await loadFixture());
  const expected = deriveJobId(baseline);
  const otherNetwork = Uint8Array.from(baseline.genesisHash);
  otherNetwork[0] = (otherNetwork[0] ?? 0) ^ 1;
  const otherCreation = Uint8Array.from(baseline.creationCommitment);
  otherCreation[0] = (otherCreation[0] ?? 0) ^ 1;
  const otherPolicy = Uint8Array.from(baseline.policyScriptHash);
  otherPolicy[31] = (otherPolicy[31] ?? 0) ^ 1;

  const variants: JobIdentityInput[] = [
    { ...baseline, genesisHash: otherNetwork },
    { ...baseline, protocolVersion: 2 },
    { ...baseline, creationCommitment: otherCreation },
    { ...baseline, anchor: { kind: "output_index", outputIndex: 3n } },
    { ...baseline, anchor: { kind: "type_id", typeId: new Uint8Array(32) } },
    { ...baseline, creatorNonce: baseline.creatorNonce + 1n },
    { ...baseline, policyScriptHash: otherPolicy },
  ];

  for (const variant of variants) {
    assert.notDeepEqual(deriveJobId(variant), expected);
  }
});

test("identity rejects non-canonical field widths and integer ranges", () => {
  const valid: JobIdentityInput = {
    genesisHash: new Uint8Array(32),
    protocolVersion: 1,
    creationCommitment: new Uint8Array(32),
    anchor: { kind: "output_index", outputIndex: 0n },
    creatorNonce: 0n,
    policyScriptHash: new Uint8Array(32),
  };

  assert.throws(() => deriveJobId({ ...valid, genesisHash: new Uint8Array(31) }), RangeError);
  assert.throws(() => deriveJobId({ ...valid, protocolVersion: 65_536 }), RangeError);
  assert.throws(
    () => deriveJobId({ ...valid, anchor: { kind: "output_index", outputIndex: -1n } }),
    RangeError,
  );
  assert.throws(() => deriveJobId({ ...valid, creatorNonce: 1n << 64n }), RangeError);
});
