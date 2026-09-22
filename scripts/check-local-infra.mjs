/* global fetch */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const composeFile = fileURLToPath(new URL("deploy/docker/compose.yml", root));
const services = ["postgres", "redis"];
const failures = [];

for (const service of services) {
  let containerId;
  try {
    containerId = execFileSync(
      "docker",
      ["compose", "--file", composeFile, "ps", "--quiet", service],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    failures.push(`${service}: unable to query Compose (${error})`);
    continue;
  }

  if (!containerId) {
    failures.push(`${service}: container is not running`);
    continue;
  }

  const status = execFileSync(
    "docker",
    ["inspect", "--format", "{{.State.Health.Status}}", containerId],
    { encoding: "utf8" },
  ).trim();

  if (status !== "healthy") {
    failures.push(`${service}: health status is ${status}`);
  } else {
    console.log(`${service}: healthy`);
  }
}

try {
  const response = await fetch(process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_tip_header", params: [] }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error || !payload.result?.hash) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  console.log(`ckb: healthy at ${payload.result.number}`);
} catch (error) {
  failures.push(`ckb: RPC unavailable (${error})`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Local infrastructure ready: ${services.length + 1} services`);
}
