import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const target = "riscv64imac-unknown-none-elf";
const binaries = ["job-lock", "deadline-policy", "recurring-policy", "demo-campaign-type"];
const comparisonRoot = new URL("target/reproducibility/", root);

await rm(comparisonRoot, { force: true, recursive: true });

function build(outputDirectory) {
  execFileSync("cargo", ["build-contracts", "--locked"], {
    cwd: fileURLToPath(root),
    env: {
      ...process.env,
      CARGO_INCREMENTAL: "0",
      CARGO_TARGET_DIR: fileURLToPath(new URL(outputDirectory, comparisonRoot)),
      SOURCE_DATE_EPOCH: "0",
    },
    stdio: "inherit",
  });
}

async function digest(outputDirectory, binary) {
  const path = new URL(`${outputDirectory}/${target}/release/${binary}`, comparisonRoot);
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

build("first/");
build("second/");

const mismatches = [];
for (const binary of binaries) {
  const first = await digest("first", binary);
  const second = await digest("second", binary);
  if (first !== second) {
    mismatches.push(`${binary}: ${first} != ${second}`);
  } else {
    console.log(`${binary} ${first}`);
  }
}

if (mismatches.length > 0) {
  console.error(mismatches.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Reproducible contract build verified for ${binaries.length} binaries`);
}
