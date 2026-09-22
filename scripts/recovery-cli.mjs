#!/usr/bin/env node

import { executeRecoveryCli, formatRecoveryCliResult } from "./recovery-cli-lib.mjs";

try {
  const result = await executeRecoveryCli(process.argv.slice(2));
  process.stdout.write(formatRecoveryCliResult(result));
} catch (error) {
  process.stderr.write(
    formatRecoveryCliResult({
      error: {
        name: error instanceof Error ? error.name : "Error",
        ...(typeof error === "object" && error !== null && "code" in error
          ? { code: error.code }
          : {}),
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
  process.exitCode = 1;
}
