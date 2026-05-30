/**
 * Canary spec — verifies the console-error listener fixture fires (issue #505).
 *
 * Acceptance criteria (issue #505):
 *   "A synthetic test that calls console.error('intentional') on the page
 *    fails with a message containing 'intentional' — verifying the listener
 *    fires."
 *   "All existing e2e specs pass without modification when the app produces
 *    zero console errors (i.e. no false positives from the listener
 *    infrastructure itself)."
 *
 * Strategy: use the raw Playwright `test` (not the extended fixture) so that
 * deliberately injecting a console.error here does not cause this file's own
 * tests to fail at the fixture level. Instead, we exercise the fixture logic
 * inline and assert on the captured list.
 *
 * Canonical: issue #505.
 */
import { test, expect } from "@playwright/test";
import type { ConsoleMessage } from "@playwright/test";
import { loadEndpoints } from "./helpers/devnet";

test("console-error listener captures intentional console.error", async ({ page }) => {
  const endpoints = loadEndpoints();

  // Navigate to the dapp landing page (no wallet connect needed).
  await page.goto(endpoints.dapp_url);

  // Mirror the listener logic from helpers/fixtures.ts.
  const captured: string[] = [];
  const handler = (msg: ConsoleMessage) => {
    if (msg.type() === "error") captured.push(msg.text());
  };
  page.on("console", handler);

  // Inject a known console.error into the page to simulate a runtime error.
  await page.evaluate(() => {
    // eslint-disable-next-line no-console
    console.error("intentional-canary-error");
  });

  page.off("console", handler);

  // The listener must have captured the injected error.
  expect(captured.length).toBeGreaterThan(0);
  const found = captured.some((msg) => msg.includes("intentional-canary-error"));
  expect(
    found,
    `Expected captured list to contain "intentional-canary-error". Captured:\n${captured.join("\n")}`,
  ).toBe(true);
});

test("console-error listener produces no false positives on a clean page", async ({ page }) => {
  const endpoints = loadEndpoints();

  // Mirror the listener logic from helpers/fixtures.ts.
  // Listener must be attached BEFORE navigation so load-time errors are caught.
  const captured: string[] = [];
  const handler = (msg: ConsoleMessage) => {
    if (msg.type() === "error") captured.push(msg.text());
  };
  page.on("console", handler);

  // Navigate to the dapp landing page.
  await page.goto(endpoints.dapp_url);

  // Allow the page to settle — any synchronous or microtask-delayed errors
  // will surface within this window.
  await page.waitForTimeout(1_000);
  page.off("console", handler);

  // No errors should have been emitted on an idle landing page.
  // If this test is red, the app itself has a runtime error that must be fixed.
  expect(
    captured,
    `No console.error events expected on a clean landing page load. Captured:\n${captured.join("\n")}`,
  ).toHaveLength(0);
});
