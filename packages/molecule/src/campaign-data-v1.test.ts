import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bytes } from "@ckb-lumos/codec";

import { CampaignDataV1 } from "./generated/campaign_v1.ts";

interface CampaignFixture {
  version: number;
  state: number;
  campaign_id: string;
  pledged: string;
  pledge_count: number;
  target: string;
  deadline_since: string;
  success_lock_hash: string;
  refund_commitment: string;
  expected_hex: string;
}

function byteArray(hex: string): number[] {
  return Array.from(bytes.bytify(hex));
}

test("CampaignDataV1 matches the cross-language fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/campaign_data_v1.json", import.meta.url),
      "utf8",
    ),
  ) as CampaignFixture;
  const encoded = CampaignDataV1.pack({
    version: fixture.version,
    state: fixture.state,
    campaign_id: byteArray(fixture.campaign_id),
    pledged: fixture.pledged,
    pledge_count: fixture.pledge_count,
    target: fixture.target,
    deadline_since: fixture.deadline_since,
    success_lock_hash: byteArray(fixture.success_lock_hash),
    refund_commitment: byteArray(fixture.refund_commitment),
  });

  assert.equal(bytes.hexify(encoded), fixture.expected_hex);
  const decoded = CampaignDataV1.unpack(encoded);
  assert.equal(decoded.pledged.toString(), fixture.pledged);
  assert.equal(decoded.target.toString(), fixture.target);
});
