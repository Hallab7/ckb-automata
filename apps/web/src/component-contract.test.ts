import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("interactive components retain their accessible state announcements", async () => {
  const [progress, dashboard, settings, shell] = await Promise.all([
    readFile(new URL("./setup/transaction-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("./dashboard/dashboard-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("./settings/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("./shell/app-shell.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(progress, /aria-live="polite"/);
  assert.match(progress, /aria-current=\{active \? "step" : undefined\}/);
  assert.match(progress, /aria-label="Transaction confirmation stages"/);
  assert.match(dashboard, /aria-pressed=\{mode === "owner"\}/);
  assert.match(dashboard, /aria-pressed=\{mode === "public"\}/);
  assert.match(settings, /aria-labelledby="settings-title"/);
  assert.match(settings, /aria-labelledby="notification-settings-title"/);
  assert.match(shell, /href="#main-content"/);
  assert.match(shell, /aria-label="Primary"/);
});

test("error surfaces expose retry controls and preserve the last verified stream state", async () => {
  const [detail, progress, dashboard, activity] = await Promise.all([
    readFile(new URL("./detail/job-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("./setup/transaction-progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("./dashboard/dashboard-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("./activity/activity-view.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /startPolling\(\)/);
  assert.match(progress, /last verified state is retained/i);
  assert.match(dashboard, />\s*Retry\s*</);
  assert.match(activity, />\s*Retry\s*</);
});
