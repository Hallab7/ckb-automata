import { readdir, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const excludedDirectories = new Set([".git", "node_modules", "target"]);
const textExtensions = new Set([
  ".env",
  ".example",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);
const signatures = [
  {
    name: "private key block",
    pattern: new RegExp(["-----BEGIN ", "PRIVATE KEY-----"].join("")),
  },
  {
    name: "AWS access key",
    pattern: new RegExp(`${["A", "KIA"].join("")}[A-Z0-9]{16}`),
  },
  {
    name: "GitHub token",
    pattern: new RegExp(`${["g", "hp_"].join("")}[A-Za-z0-9]{36,}`),
  },
  {
    name: "Slack token",
    pattern: new RegExp(`${["xo", "x[baprs]-"].join("")}[A-Za-z0-9-]{20,}`),
  },
  {
    name: "configured executor key",
    pattern: new RegExp(`${["EXECUTOR_FEE_", "PRIVATE_KEY"].join("")}\\s*=\\s*0x[a-fA-F0-9]{64}`),
  },
  {
    name: "configured user signing material",
    pattern: new RegExp(
      `${["USER_", "(?:PRIVATE_KEY|SEED_PHRASE|MNEMONIC)"].join("")}\\s*=\\s*\\S{16,}`,
    ),
  },
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return excludedDirectories.has(entry.name)
          ? []
          : collectFiles(new URL(`${entry.name}/`, directory));
      }
      const extension = extname(entry.name);
      return textExtensions.has(extension) || entry.name.startsWith(".env")
        ? [new URL(entry.name, directory)]
        : [];
    }),
  );
  return nested.flat();
}

const rootPath = fileURLToPath(root);
const findings = [];
for (const file of await collectFiles(root)) {
  const content = await readFile(file, "utf8");
  for (const signature of signatures) {
    if (signature.pattern.test(content)) {
      findings.push(`${fileURLToPath(file).slice(rootPath.length)}: ${signature.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.map((finding) => `- ${finding}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed: ${signatures.length} high-confidence signatures`);
}
