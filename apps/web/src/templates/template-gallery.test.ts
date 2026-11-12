import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { TEMPLATE_CATALOG } from "./template-catalog.ts";

test("template availability matches implemented product boundaries", () => {
  assert.deepEqual(
    TEMPLATE_CATALOG.map(({ capability, id }) => [id, capability]),
    [
      ["deadline", "executable"],
      ["recurring", "executable"],
      ["demo", "demo"],
      ["dao-harvest", "executable"],
    ],
  );
  const executable = TEMPLATE_CATALOG.filter((template) => template.capability === "executable");
  assert.deepEqual(
    executable.map((template) => template.action.href),
    ["/automations/new/deadline", "/automations/new/recurring", "/automations/new/dao-harvest-v3"],
  );
  assert.ok(
    TEMPLATE_CATALOG.filter((template) => template.capability !== "executable").every(
      (template) => !template.action.label.toLowerCase().includes("create"),
    ),
  );
});

test("creation gallery stays focused on executable automation choices", async () => {
  for (const template of TEMPLATE_CATALOG) {
    assert.ok(template.risk.length > 20, `${template.id} risk is too vague`);
    assert.ok(template.approval.length > 20, `${template.id} approval is too vague`);
    assert.ok(template.recoverability.length > 20, `${template.id} recovery is too vague`);
  }
  const source = await readFile(new URL("./template-gallery.tsx", import.meta.url), "utf8");
  assert.match(source, /template\.capability === "executable"/);
  assert.match(source, /data-create-action="true"/);
  assert.doesNotMatch(source, /Guided scenarios|Demo only|NervDAO Cycle Guard|Research only/);
  assert.doesNotMatch(source, /template-card__facts/);
  assert.match(source, /daoHarvestV3SetupEnabled/);
  assert.match(source, /template\.id !== "dao-harvest"/);
});

test("direct V2 setup navigation fails closed with the public switch", async () => {
  const source = await readFile(
    new URL("../../app/(setup)/automations/new/dao-harvest-v2/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /!browserWebEnvironment\(\)\.daoHarvestV2SetupEnabled/);
  assert.match(source, /New DAO harvest setup is paused/);
});

test("direct V3 setup navigation fails closed until every release gate passes", async () => {
  const source = await readFile(
    new URL("../../app/(setup)/automations/new/dao-harvest-v3/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /!browserWebEnvironment\(\)\.daoHarvestV3SetupEnabled/);
  assert.match(source, /independent security review must be complete/);
});

test("V3 setup uses its closed request, review, and signer-bound submission path", async () => {
  const source = await readFile(
    new URL("../setup/dao-harvest-v2-setup.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /buildDaoHarvestV3\("setup", body\)/);
  assert.match(source, /fallbackOperatorLockHashes/);
  assert.match(source, /verifyCompletedDaoHarvestV3Review/);
  assert.match(source, /verifyDaoHarvestV3SignerChain/);
  assert.match(source, /verifyRefreshedDaoHarvestV3Build/);
  assert.match(source, /storageId={`v\$\{revision\}`}/);
});
