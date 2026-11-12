import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDaoHarvestV3ManifestArguments } from "./create-dao-harvest-v3-manifest.mjs";

const root = new URL("../", import.meta.url);

test("V3 deployment descriptor uses the exact immutable contract order", async () => {
  const source = await readFile(
    new URL("deploy/testnet/dao-harvest-v3-contracts.toml", root),
    "utf8",
  );
  const names = [...source.matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(names, [
    "dao-harvest-job-lock-v3",
    "dao-harvest-policy-v3",
    "harvest-vault-lock-v3",
    "compensation-lock-v3",
  ]);
  assert.match(source, /code_hash = "0x0{64}"/);
  assert.match(source, /hash_type = "data1"/);
});

test("V3 manifest output is versioned and cannot target an ambiguous filename", () => {
  const parsed = parseDaoHarvestV3ManifestArguments([
    "--transaction-hash",
    `0x${"1".repeat(64)}`,
    "--release-version",
    "0.3.0",
  ]);
  assert.match(parsed.output, /dao-harvest-v3-testnet-v0\.3\.0\.json$/);
  assert.throws(
    () =>
      parseDaoHarvestV3ManifestArguments([
        "--transaction-hash",
        `0x${"1".repeat(64)}`,
        "--release-version",
        "0.3.0",
        "--output",
        "deploy/manifests/dao-harvest-v3-testnet.json",
      ]),
    /must end with/,
  );
});

test("V3 manifest generation cannot weaken the five-confirmation policy", async () => {
  const source = await readFile(
    new URL("scripts/create-dao-harvest-v3-manifest.mjs", root),
    "utf8",
  );
  assert.match(source, /requiredConfirmations >= 5n/);
});
