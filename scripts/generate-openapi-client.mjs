import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { format } from "prettier";

import { createApiApplication } from "../apps/api/src/bootstrap.ts";
import { createOpenApiDocument } from "../apps/api/src/openapi.ts";
import { deploymentRegistry } from "../packages/core/src/index.ts";

const requireFromCodegen = createRequire(
  new URL("../tools/openapi-codegen/package.json", import.meta.url),
);
const openapiModule = await import(
  pathToFileURL(requireFromCodegen.resolve("openapi-typescript")).href
);
const openapiTS =
  typeof openapiModule.default === "function"
    ? openapiModule.default
    : openapiModule.default.default;
const { COMMENT_HEADER, astToString } = openapiModule;

const checkOnly = process.argv.slice(2).includes("--check");
const openApiUrl = new URL("../packages/api-client/openapi.json", import.meta.url);
const generatedUrl = new URL("../packages/api-client/src/generated/openapi.ts", import.meta.url);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash, "the deployment registry must contain a network");
const quietLogger = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};
const result = await createApiApplication(
  {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: genesisHash,
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  },
  { logger: quietLogger },
);

let document;
try {
  await result.app.init();
  document = canonical(createOpenApiDocument(result.app));
} finally {
  await result.app.close();
}

const openApi = await format(JSON.stringify(document), { parser: "json", printWidth: 100 });
const nodes = await openapiTS(document, {
  alphabetize: true,
  emptyObjectsUnknown: true,
  exportType: true,
  immutable: true,
  silent: true,
});
const generated = `${COMMENT_HEADER}${astToString(nodes)}`.replaceAll("\r\n", "\n");
const outputs = [
  [openApiUrl, openApi],
  [generatedUrl, generated],
];

if (checkOnly) {
  for (const [url, expected] of outputs) {
    const actual = await readFile(url, "utf8");
    assert.equal(actual.replaceAll("\r\n", "\n"), expected, `${url.pathname} is stale`);
  }
  console.log("OpenAPI document and TypeScript client are current");
} else {
  await mkdir(new URL("../packages/api-client/src/generated/", import.meta.url), {
    recursive: true,
  });
  for (const [url, content] of outputs) await writeFile(url, content);
  console.log("Generated OpenAPI document and TypeScript client");
}
