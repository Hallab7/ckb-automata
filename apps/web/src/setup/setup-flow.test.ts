import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FIRST_SETUP_STEP,
  SETUP_STEPS,
  parseSetupStep,
  parseStoredDraft,
  setupStepUrl,
} from "./setup-flow.ts";

test("setup progress uses canonical URL-safe step identifiers", () => {
  assert.deepEqual(
    SETUP_STEPS.map((step) => step.id),
    ["template", "details", "timing", "funding", "review", "approval", "result"],
  );
  assert.equal(FIRST_SETUP_STEP, "details");
  assert.equal(parseSetupStep("funding"), "funding");
  assert.equal(parseSetupStep("template"), "details");
  assert.equal(parseSetupStep("../../approval"), "details");
  assert.equal(parseSetupStep(null), "details");
  assert.equal(setupStepUrl("/automations/new/deadline", "details"), "/automations/new/deadline");
  assert.equal(
    setupStepUrl("/automations/new/deadline", "review"),
    "/automations/new/deadline?step=review",
  );
});

test("draft restoration accepts only string field records", () => {
  assert.deepEqual(parseStoredDraft('{"recipient":"ckt1test","amount":"100"}'), {
    amount: "100",
    recipient: "ckt1test",
  });
  assert.equal(parseStoredDraft('{"amount":100}'), undefined);
  assert.equal(parseStoredDraft("[]"), undefined);
  assert.equal(parseStoredDraft("not-json"), undefined);
});

test("stepper protects dirty drafts and focuses the first invalid field", async () => {
  const source = await readFile(new URL("./setup-stepper.tsx", import.meta.url), "utf8");
  assert.match(source, /beforeunload/);
  assert.match(source, /popstate/);
  assert.match(source, /Leave setup and discard the unsaved draft/);
  assert.match(source, /querySelector<HTMLElement>/);
  assert.match(source, /data-field-name/);
  assert.match(source, /\.focus\(\)/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /await validateStep/);
  assert.match(source, /disabled=\{validating\}/);
});
