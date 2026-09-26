import assert from "node:assert/strict";
import test from "node:test";

import {
  automationTitle,
  readAutomationTitles,
  validateAutomationTitle,
  writeAutomationTitle,
} from "./automation-title.ts";

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

test("automation titles are optional, trimmed, and length-limited", () => {
  assert.equal(automationTitle({ title: "  Supplier payment  " }), "Supplier payment");
  assert.equal(automationTitle({ title: "  " }), undefined);
  assert.equal(
    validateAutomationTitle({ title: "x".repeat(81) }),
    "Keep the title to 80 characters or fewer.",
  );
});

test("automation titles persist only for canonical job identifiers", () => {
  const target = storage();
  const jobId = `0x${"12".repeat(32)}`;
  assert.equal(writeAutomationTitle(target, jobId, "Supplier payment"), true);
  assert.deepEqual(readAutomationTitles(target), { [jobId]: "Supplier payment" });
  assert.equal(writeAutomationTitle(target, "not-a-job", "Ignored"), false);
});
