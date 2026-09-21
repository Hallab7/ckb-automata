import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const packageDirectories = [
  "packages/core",
  "packages/molecule",
  "packages/ccc",
  "packages/adapters",
  "packages/api-client",
  "packages/ui",
  "packages/config",
  "packages/testing",
];
const consumerDirectories = [
  "apps/web",
  "apps/api",
  "apps/executor",
  ...packageDirectories,
];

const manifests = new Map();
for (const directory of consumerDirectories) {
  const manifestUrl = new URL(`${directory}/package.json`, root);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  manifests.set(directory, { manifest, manifestUrl });
}

const expectedNames = new Map(
  packageDirectories.map((directory) => [
    `@ckb-automata/${directory.split("/").at(-1)}`,
    directory,
  ]),
);

const failures = [];
for (const [packageName, directory] of expectedNames) {
  const actualName = manifests.get(directory)?.manifest.name;
  if (actualName !== packageName) {
    failures.push(`${directory} must be named ${packageName}`);
    continue;
  }

  const consumer = [...manifests.values()].find(({ manifest }) => {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    return dependencies[packageName]?.startsWith("workspace:");
  });

  if (!consumer) {
    failures.push(`${packageName} has no workspace consumer`);
    continue;
  }

  try {
    const requireFromConsumer = createRequire(consumer.manifestUrl);
    const resolvedManifest = requireFromConsumer.resolve(
      `${packageName}/package.json`,
    );
    await access(resolvedManifest);
  } catch (error) {
    failures.push(`${packageName} cannot be resolved by package name: ${error}`);
  }
}

for (const [directory] of manifests) {
  const tsconfig = JSON.parse(
    await readFile(new URL(`${directory}/tsconfig.json`, root), "utf8"),
  );
  if (tsconfig.compilerOptions?.paths) {
    failures.push(`${directory} uses a source-path alias`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Workspace valid: ${expectedNames.size} packages resolve by package name without path aliases`,
  );
}
