import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const secondsIndex = args.indexOf("--seconds");
const runsIndex = args.indexOf("--runs");
const seconds = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : undefined;
const runs = runsIndex >= 0 ? Number(args[runsIndex + 1]) : 256;
if (
  (seconds !== undefined && (!Number.isInteger(seconds) || seconds <= 0)) ||
  !Number.isInteger(runs) ||
  runs <= 0
) {
  throw new Error("fuzz budgets must be positive integers");
}

const fuzzDirectory = fileURLToPath(new URL("../fuzz/", import.meta.url));
const targets = ["molecule_parsing", "witness_arithmetic", "malformed_transaction"];
const budget = seconds === undefined ? `-runs=${runs}` : `-max_total_time=${seconds}`;

if (process.platform === "win32") {
  const workspace = fileURLToPath(new URL("../", import.meta.url));
  const commands = [
    "rustup toolchain install nightly-2026-09-01 --profile minimal",
    "cargo +nightly-2026-09-01 install cargo-fuzz --version 0.13.2 --locked",
    ...targets.map(
      (target, index) => `cargo fuzz run ${target} -- ${budget} -seed=${424242 + index}`,
    ),
  ];
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--volume",
      `${workspace}:/work`,
      "--workdir",
      "/work/fuzz",
      "--env",
      "CARGO_TARGET_DIR=/work/target/fuzz-linux",
      "rust:1.93.1-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31",
      "bash",
      "-c",
      commands.join(" && "),
    ],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

for (const [index, target] of targets.entries()) {
  const cargoArguments = ["fuzz", "run"];
  cargoArguments.push(target, "--", budget, `-seed=${424242 + index}`);
  const result = spawnSync("cargo", cargoArguments, {
    cwd: fuzzDirectory,
    encoding: "utf8",
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
