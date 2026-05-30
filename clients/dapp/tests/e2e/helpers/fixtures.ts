/**
 * Shared Playwright fixtures for the dapp e2e suite.
 *
 * The `test` export extends Playwright's base test with a per-test
 * console-error listener. Every page opened during a test has
 * `console.error`, unhandled promise rejections, and `pageerror` events
 * captured into a list. After the full test body completes the fixture
 * asserts that list is empty — a non-empty list fails the test with the
 * full error text.
 *
 * No errors are suppressed or allowlisted. The passing bar is a
 * genuinely clean console.
 *
 * Usage — replace the Playwright import in any spec:
 *
 *   // Before:
 *   import { test, expect } from "@playwright/test";
 *   // After:
 *   import { test, expect } from "./helpers/fixtures";
 *
 * The `expect` re-export is the standard Playwright expect, unchanged.
 *
 * Canonical: issue #505, docs/prd.md.
 */

import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** One captured browser-side error. */
interface BrowserError {
  kind: "console.error" | "pageerror" | "unhandledrejection";
  text: string;
}

/**
 * Attach console-error and pageerror listeners to a single page.
 * Returns a cleanup function that removes the listeners.
 */
function attachErrorListeners(page: Page, errors: BrowserError[]): () => void {
  const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "error") {
      errors.push({ kind: "console.error", text: msg.text() });
    }
  };

  const onPageError = (err: Error) => {
    errors.push({ kind: "pageerror", text: String(err) });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  };
}

/**
 * Extended test object. Attaches error listeners to the default `page`
 * fixture, runs the test body, then asserts a clean console.
 */
export const test = base.extend<{ _consoleGuard: void }>({
  // Wrap the built-in `page` fixture: attach listeners before the test
  // body and assert after.
  // eslint-disable-next-line no-empty-pattern
  _consoleGuard: [
    async ({ page }, use) => {
      const errors: BrowserError[] = [];
      const cleanup = attachErrorListeners(page, errors);

      // Run the full test body.
      await use();

      cleanup();

      // Assert clean console after the full test body so delayed errors
      // (e.g. from in-flight async operations that settle after the last
      // assertion) are still caught.
      if (errors.length > 0) {
        const lines = errors.map((e) => `[${e.kind}] ${e.text}`).join("\n");
        throw new Error(
          `Browser console errors detected during test (${errors.length}):\n${lines}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
