import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageUrl = new URL("packages/nervdao-integration/package.json", root);
const sourceUrl = new URL("packages/nervdao-integration/src/index.ts", root);
const consumerUrl = new URL("tools/nervdao-integration-consumer/package.json", root);
const manifest = JSON.parse(await readFile(packageUrl, "utf8"));
const source = await readFile(sourceUrl, "utf8");
const consumer = JSON.parse(await readFile(consumerUrl, "utf8"));
const dependencies = {
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
};
const forbidden = [
  "elliptic",
  "@nervosnetwork/ckb-sdk-utils",
  "@ckb-ccc/",
  "@ckb-automata/core",
  "@ckb-automata/api-client",
];
const failures = forbidden.filter(
  (name) =>
    Object.keys(dependencies).some(
      (dependency) => dependency === name || dependency.startsWith(name),
    ) ||
    source.includes(`from "${name}`) ||
    source.includes(`from '${name}`),
);
if (
  Object.keys(consumer.dependencies ?? {}).some(
    (dependency) => dependency !== "@ckb-automata/nervdao-integration",
  )
) {
  failures.push("consumer fixture runtime dependency");
}
if (failures.length > 0) {
  console.error(
    `NervDAO integration includes forbidden browser dependencies: ${failures.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "NervDAO integration dependency boundary passed: zero runtime dependencies and no elliptic path",
  );
}
