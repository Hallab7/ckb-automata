import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const rootLayout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const productLayout = await readFile(
  new URL("../app/(product)/layout.tsx", import.meta.url),
  "utf8",
);
const setupLayout = await readFile(new URL("../app/(setup)/layout.tsx", import.meta.url), "utf8");
const limitations = await readFile(
  new URL("../app/(product)/limitations/page.tsx", import.meta.url),
  "utf8",
);

test("public frontend publishes CSP and defense-in-depth response headers", () => {
  for (const header of [
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]) {
    assert.match(config, new RegExp(header));
  }
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /object-src 'none'/);
});

test("live route groups fail closed behind deployment identity verification", () => {
  assert.match(productLayout, /<PublicDeploymentGate>\{children\}<\/PublicDeploymentGate>/);
  assert.match(setupLayout, /<PublicDeploymentGate>\{children\}<\/PublicDeploymentGate>/);
  assert.match(limitations, /Independent executor services are not active yet/);
});

test("analytics requires browser consent and limitations remain public", () => {
  assert.match(rootLayout, /<AnalyticsConsent \/>/);
  assert.match(limitations, /<AnalyticsPreferences \/>/);
});
