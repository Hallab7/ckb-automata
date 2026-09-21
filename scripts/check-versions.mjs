import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageManifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const versions = JSON.parse(await readFile(new URL("config/versions.json", root), "utf8"));

const failures = [];
const exactSemver = /^\d+\.\d+\.\d+$/;
const digestImage = /^[^\s]+:\d+(?:\.\d+){1,2}[^\s]*@sha256:[a-f0-9]{64}$/;

for (const [name, version] of Object.entries(versions.directDependencies)) {
  if (!exactSemver.test(version)) {
    failures.push(`${name} is not pinned to an exact semantic version`);
  }
}

for (const [name, image] of Object.entries(versions.dockerImages)) {
  if (!digestImage.test(image)) {
    failures.push(`${name} is not pinned by an exact tag and SHA-256 digest`);
  }
}

for (const [name, version] of Object.entries(packageManifest.devDependencies)) {
  if (!exactSemver.test(version)) {
    failures.push(`${name} in package.json is not exact`);
  }
  if (versions.directDependencies[name] !== version) {
    failures.push(`${name} differs between package.json and versions.json`);
  }
}

const expectedPackageManager = `pnpm@${versions.toolchain.pnpm}`;
if (packageManifest.packageManager !== expectedPackageManager) {
  failures.push("packageManager does not match the pnpm toolchain pin");
}

if (packageManifest.engines.node !== versions.toolchain.node) {
  failures.push("Node engine does not match the toolchain pin");
}

if (packageManifest.engines.pnpm !== versions.toolchain.pnpm) {
  failures.push("pnpm engine does not match the toolchain pin");
}

if (process.versions.node !== versions.toolchain.node) {
  failures.push(`running Node ${process.versions.node} does not match ${versions.toolchain.node}`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Version pins valid: Node ${versions.toolchain.node}, pnpm ${versions.toolchain.pnpm}, Rust ${versions.toolchain.rust}`,
  );
}
