/**
 * Playwright E2E — unpause flow UI invariants (issue #82).
 *
 * Runs against the smoke-test full-stack devnet. Connects as the
 * admin EOA for the positive structured-preview path, and as the
 * agent EOA (no admin role) for the disabled-button negative path.
 */
import { test, expect } from "@playwright/test";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

// keccak256("unpause()")[0..4]
const UNPAUSE_SELECTOR = "0x3f4ba83a";

let endpoints: DevnetEndpoints;
test.beforeAll(() => {
  endpoints = loadEndpoints();
});

test.describe("unpause flow — UI invariants", () => {
  test("renders structured preview, signs intended calldata, no raw-calldata leak", async ({
    page,
  }) => {
    await openDapp(page, endpoints);
    await openTab(page, "pause");

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

    const calldataDetails = unpauseForm.getByTestId("tx-preview-calldata-details");
    await expect(calldataDetails).toBeAttached();
    const isOpen = await calldataDetails.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);
    await expect(calldataElement).toBeHidden();
  });

  test("unpause button is disabled when wallet lacks ADMIN_ROLE", async ({ page }) => {
    // Connect as the agent EOA — it holds no roles on the gateway, so
    // unpause (which requires ADMIN_ROLE) must stay disabled.
    await openDapp(page, endpoints, { role: "agent" });
    await openTab(page, "pause");
    const unpauseBtn = page.getByTestId("unpause-submit");
    await expect(unpauseBtn).toBeDisabled();
  });
});
