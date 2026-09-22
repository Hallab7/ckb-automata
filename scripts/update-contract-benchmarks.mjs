import { spawnSync } from "node:child_process";

const result = spawnSync(
  "cargo",
  [
    "test-native",
    "--locked",
    "benchmarks::measured_contract_costs_match_the_committed_report",
    "--",
    "--exact",
  ],
  {
    env: { ...process.env, AUTOMATA_UPDATE_BENCHMARKS: "1" },
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
