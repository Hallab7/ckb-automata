#!/usr/bin/env node
import { executeDaoHarvestV3RecoveryCli } from "./dao-harvest-v3-recovery-cli-lib.mjs";

executeDaoHarvestV3RecoveryCli(process.argv.slice(2))
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
