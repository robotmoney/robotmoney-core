/**
 * Playwright E2E — pause flow (issue #82).
 *
 * Asserts the UI invariants for the pause surface:
 *   1. The pause-flow section renders with a structured preview, not a
 *      raw-calldata-only signing prompt.
 *   2. The decoded preview shape matches the expected shape (selector +
 *      function name + effect).
 *   3. The calldata that *would be signed* equals the encoder output
 *      for `pause()` — i.e. the canonical 4-byte selector `0x8456cb59`.
 *   4. No element exposes the raw calldata as user-readable text — the
 *      calldata lives inside a collapsed <details> guarded by the
 *      structured preview block; with the details closed, the calldata
 *      element is not visible.
 *
 * Mode: runs against the dev/preview server with the mock-wallet
 * connector enabled (VITE_USE_MOCK_WALLET=true).
 */
import { test, expect } from "@playwright/test";

// keccak256("pause()")[0..4]
const PAUSE_SELECTOR = "0x8456cb59";

test.describe("pause flow — UI invariants", () => {
  test("renders structured preview, signs intended calldata, no raw-calldata leak", async ({
    page,
  }) => {
    await page.goto("/");

    const connect = page.getByTestId("connect-mock");
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    // Pause-flow section is present.
    const pauseFlow = page.getByTestId("pause-flow");
    await expect(pauseFlow).toBeVisible();

    // Locate the pause sub-section.
    const pauseForm = page.getByTestId("pause-form");
    await expect(pauseForm).toBeVisible();

    // Structured preview, not a refusal.
    const previewFn = pauseForm.getByTestId("tx-preview-fn");
    await expect(previewFn).toHaveText("pause");
    await expect(pauseForm.getByTestId("tx-preview-effect")).toContainText("paused state");
    await expect(pauseForm.locator('[data-testid="refusal-reason"]')).toHaveCount(0);

    // Selector matches the canonical pause() 4-byte selector.
    await expect(pauseForm.getByTestId("tx-preview-selector")).toHaveText(PAUSE_SELECTOR);

    // Calldata that would be signed equals the encoder output. For
    // pause() that is exactly the 4-byte selector (no args).
    const calldataElement = pauseForm.getByTestId("tx-preview-calldata");
    const calldataText = await calldataElement.textContent();
    expect(calldataText).toBe(PAUSE_SELECTOR);

    // No raw-calldata leak: the <details> wrapper is closed by default,
    // so the calldata element is not visible to a reading user. We
    // assert (a) the wrapper exists, (b) the wrapper is NOT open, and
    // (c) the calldata element is hidden from the accessibility tree.
    const calldataDetails = pauseForm.getByTestId("tx-preview-calldata-details");
    await expect(calldataDetails).toBeAttached();
    const isOpen = await calldataDetails.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);
    await expect(calldataElement).toBeHidden();
  });
});
