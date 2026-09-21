import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const cliArguments = process.argv.slice(2).filter((argument) => argument !== "--");
const subjects =
  cliArguments[0] === "--range"
    ? execFileSync("git", ["log", "--format=%s", cliArguments[1]], {
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
    : [
        cliArguments[0]
          ? (await readFile(cliArguments[0], "utf8")).split(/\r?\n/, 1)[0].trim()
          : execFileSync("git", ["log", "-1", "--format=%s"], {
              encoding: "utf8",
            }).trim(),
      ];

const conventionalSubject =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: [a-z0-9].{0,71}$/;
const restrictedTerm = ["pha", "se"].join("");
const failures = subjects.flatMap((subject) => {
  const subjectFailures = [];
  if (!conventionalSubject.test(subject)) {
    subjectFailures.push("must use a conventional type and be at most 100 characters");
  }
  if (subject.toLowerCase().includes(restrictedTerm)) {
    subjectFailures.push("contains a prohibited term");
  }
  return subjectFailures.map((failure) => `${subject}: ${failure}`);
});

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Commit subjects valid: ${subjects.length}`);
}
