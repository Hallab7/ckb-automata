import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const fixtureRoot = new URL("target/quality-self-test/", root);

await rm(fixtureRoot, { force: true, recursive: true });
await mkdir(fixtureRoot, { recursive: true });

const fixtures = {
  commit: new URL("commit-message.txt", fixtureRoot),
  javascript: new URL("bad-lint.mjs", fixtureRoot),
  rust: new URL("bad-format.rs", fixtureRoot),
  typescript: new URL("bad-type.ts", fixtureRoot),
  typescriptConfig: new URL("tsconfig.json", fixtureRoot),
};

await Promise.all([
  writeFile(fixtures.commit, `feat: include ${["pha", "se"].join("")} label\n`),
  writeFile(fixtures.javascript, "const unused = 1;\n"),
  writeFile(fixtures.rust, "pub fn badly_formatted( )->bool{true}\n"),
  writeFile(fixtures.typescript, "const value: string = 1;\nvoid value;\n"),
  writeFile(
    fixtures.typescriptConfig,
    JSON.stringify({
      extends: "../../tsconfig.base.json",
      include: ["bad-type.ts"],
    }),
  ),
]);

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commands = [
  ["Prettier", pnpm, ["exec", "prettier", "--check", fileURLToPath(fixtures.javascript)]],
  [
    "ESLint",
    pnpm,
    [
      "exec",
      "eslint",
      "--no-ignore",
      "--config",
      "eslint.config.mjs",
      fileURLToPath(fixtures.javascript),
    ],
  ],
  ["Oxlint", pnpm, ["exec", "oxlint", "--deny-warnings", fileURLToPath(fixtures.javascript)]],
  ["TypeScript", pnpm, ["exec", "tsc", "-p", fileURLToPath(fixtures.typescriptConfig)]],
  ["rustfmt", "rustfmt", ["--check", fileURLToPath(fixtures.rust)]],
  [
    "commit",
    process.execPath,
    ["scripts/check-commit-message.mjs", fileURLToPath(fixtures.commit)],
  ],
];

const failures = [];
for (const [name, command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: fileURLToPath(root),
    encoding: "utf8",
    shell: false,
  });
  if (result.status === 0) {
    failures.push(`${name} accepted its malformed fixture`);
  } else {
    console.log(`${name} rejected its malformed fixture`);
  }
}

const clippyRoot = new URL("clippy/", fixtureRoot);
await mkdir(new URL("src/", clippyRoot), { recursive: true });
await writeFile(
  new URL("Cargo.toml", clippyRoot),
  '[package]\nname = "quality-self-test"\nversion = "0.0.0"\nedition = "2024"\n\n[workspace]\n',
);
await writeFile(
  new URL("src/lib.rs", clippyRoot),
  "pub fn equal_to_itself(value: i32) -> bool { value == value }\n",
);

const clippy = spawnSync(
  "cargo",
  [
    "clippy",
    "--manifest-path",
    fileURLToPath(new URL("Cargo.toml", clippyRoot)),
    "--",
    "-D",
    "warnings",
  ],
  {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  },
);

if (clippy.status === 0) {
  failures.push("Clippy accepted its malformed fixture");
} else {
  console.log("Clippy rejected its malformed fixture");
}

await rm(fixtureRoot, { force: true, recursive: true });

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Quality self-test passed for ${commands.length + 1} failure gates`);
}
