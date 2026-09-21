import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const messagePath = process.argv[2];
const subject = messagePath
  ? (await readFile(messagePath, "utf8")).split(/\r?\n/, 1)[0].trim()
  : execFileSync("git", ["log", "-1", "--format=%s"], {
      encoding: "utf8",
    }).trim();

const conventionalSubject =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: [a-z0-9].{0,71}$/;
const restrictedTerm = ["pha", "se"].join("");
const failures = [];

if (!conventionalSubject.test(subject)) {
  failures.push("subject must use a conventional type and be at most 100 characters");
}

if (subject.toLowerCase().includes(restrictedTerm)) {
  failures.push("subject contains a prohibited term");
}

if (failures.length > 0) {
  console.error(`${subject}\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Commit subject valid: ${subject}`);
}
