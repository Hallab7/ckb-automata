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

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Local infrastructure ready: ${services.length} services`);
}
