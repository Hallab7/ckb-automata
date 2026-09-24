import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDemoDataProvider,
  createLiveDataProvider,
  DEMO_DATA_LABEL,
  LIVE_DATA_LABEL,
} from "./data-provider.ts";

test("demo fixtures and live reads use separate providers with explicit labels", async () => {
  let liveReads = 0;
  const live = createLiveDataProvider(() => {
    liveReads += 1;
    return { source: "api" } as const;
  });
  const fixture = Object.freeze({ source: "fixture" as const });
  const demo = createDemoDataProvider(fixture);

  assert.deepEqual(
    { demo: [demo.kind, demo.label], live: [live.kind, live.label] },
    {
      demo: ["demo", "Demo data"],
      live: ["live", "Live testnet data"],
    },
  );
  assert.equal(DEMO_DATA_LABEL, "Demo data");
  assert.equal(LIVE_DATA_LABEL, "Live testnet data");
  assert.equal(demo.load(), fixture);
  assert.equal(liveReads, 0, "loading demo data must not access the live provider");
  assert.deepEqual(live.load(), { source: "api" });
  assert.equal(liveReads, 1);

  const [dashboard, demoPage] = await Promise.all([
    readFile(new URL("./dashboard/automation-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(product)/demo/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /createLiveDataProvider/);
  assert.doesNotMatch(dashboard, /createDemoDataProvider/);
  assert.match(demoPage, /createDemoDataProvider/);
  assert.match(demoPage, /provider\.label/);
});
