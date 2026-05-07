/**
 * Playwright E2E — unpause flow (issue #82).
 *
 * Mirrors pause.spec.ts for the unpause action. Asserts:
 *   1. Structured preview renders for unpause (no refusal, no raw
 *      calldata-only path).
 *   2. The selector + decoded effect match the expected shape.
 *   3. The signable calldata equals the encoder output for `unpause()`
 *      — canonical selector `0x3f4ba83a`.
 *   4. No element exposes raw calldata as user-readable text; the
 *      <details> wrapper is closed, so the calldata is hidden.
 */
import { test, expect } from "@playwright/test";

// keccak256("unpause()")[0..4]
const UNPAUSE_SELECTOR = "0x3f4ba83a";

test.describe("unpause flow — UI invariants", () => {
  test("renders structured preview, signs intended calldata, no raw-calldata leak", async ({
    page,
  }) => {
    await page.goto("/");

    const connect = page.getByTestId("connect-mock");
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    const unpauseForm = page.getByTestId("unpause-form");
    await expect(unpauseForm).toBeVisible();

    const previewFn = unpauseForm.getByTestId("tx-preview-fn");
    await expect(previewFn).toHaveText("unpause");
    await expect(unpauseForm.getByTestId("tx-preview-effect")).toContainText("exits paused state");
    await expect(unpauseForm.locator('[data-testid="refusal-reason"]')).toHaveCount(0);

    await expect(unpauseForm.getByTestId("tx-preview-selector")).toHaveText(UNPAUSE_SELECTOR);

    const calldataElement = unpauseForm.getByTestId("tx-preview-calldata");
    const calldataText = await calldataElement.textContent();
    expect(calldataText).toBe(UNPAUSE_SELECTOR);

    // No raw-calldata leak: details collapsed by default.
    const calldataDetails = unpauseForm.getByTestId("tx-preview-calldata-details");
    await expect(calldataDetails).toBeAttached();
    const isOpen = await calldataDetails.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);
    await expect(calldataElement).toBeHidden();
  });

  test("unpause button is disabled when wallet lacks ADMIN_ROLE", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("connect-mock").click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    // Mock wallet on a fresh anvil holds no roles on the
    // zero-address gateway (default VITE_GATEWAY_ADDRESS), so hasRole
    // returns false. The unpause button must therefore be disabled.
    const unpauseBtn = page.getByTestId("unpause-submit");
    await expect(unpauseBtn).toBeDisabled();
  });
});
