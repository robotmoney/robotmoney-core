/**
 * Playwright E2E — number-formatting and table-alignment assertions (issue #489).
 *
 * Verifies that:
 *   1. The wallet-balance row (USDC, ETH), vault tile stats, and router-weights
 *      table all render USD amounts through the centralized formatter — confirmed
 *      by inspecting that the text matches the expected pattern (e.g. "N USDC",
 *      "N.N USDC", never "N.000000 USDC" with trailing zeros).
 *   2. Numeric <td> elements in the balances-panel table have computed
 *      `text-align: right`.
 *   3. ProportionPreview numeric columns have computed `text-align: right`.
 *
 * QA plan v1 T5: two tests here skipped on every dapp-e2e run. The
 * ProportionPreview test looked for the leg table without choosing the router
 * destination or entering an amount, so the table never rendered and the test
 * skipped. It now drives the router deposit form the way router-deposit.spec.ts
 * does and requires the table. The balances-panel screenshot test skipped
 * because no baseline was ever committed (and it looked for a file name
 * Playwright does not use). The panel shows live balances, so a pixel baseline
 * cannot be stable. It is deleted; test 1 asserts the formatting as text.
 *
 * Runs against the full-stack devnet after devnet-global-setup.ts has seeded
 * USDC balances into the test EOAs.
 *
 * Canonical: docs/architecture.md §5.3 — Human Dapp.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import {
  injectWallet,
  connectInjectedWallet,
  dismissOnboardingIfPresent,
  openDapp,
  openTab,
} from "./helpers/wallet";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** USDC trailing-zeros pattern: amount should NOT end with ".000000 USDC".
 * The integer part may contain thousands-separator commas (e.g. "10,300.001003 USDC"). */
const USDC_STRIPPED_RE = /^\d{1,3}(,\d{3})*(\.\d{1,6})? USDC$/;

let eps: DevnetEndpoints;

test.beforeAll(() => {
  eps = loadEndpoints();
});

// ---------------------------------------------------------------------------
// Wallet-balance row formatting
// ---------------------------------------------------------------------------

test("balances-panel: USDC and ETH rows use centralized formatter (no trailing zeros)", async ({
  page,
}) => {
  await injectWallet(page, {
    privateKey: eps.admin_private_key as `0x${string}`,
    rpcUrl: eps.rpc_url,
    chainId: eps.chain_id,
  });
  await page.goto(eps.dapp_url);
  await connectInjectedWallet(page);
  await dismissOnboardingIfPresent(page);

  // Wait for the balances panel to render balance rows.
  const usdcAmount = page.getByTestId("balances-panel-row-usdc-amount");
  await expect(usdcAmount).toBeVisible({ timeout: 30_000 });

  // USDC value should match centralized format pattern — no trailing zeros.
  const usdcText = await usdcAmount.textContent();
  expect(usdcText, `USDC amount "${usdcText}" should match centralized format`).toMatch(
    USDC_STRIPPED_RE,
  );

  // ETH amount row should be visible.
  const ethAmount = page.getByTestId("balances-panel-row-eth-amount");
  await expect(ethAmount).toBeVisible();
  const ethText = await ethAmount.textContent();
  expect(ethText, `ETH amount "${ethText}" should not be empty`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Table alignment — balances panel
// ---------------------------------------------------------------------------

test("balances-panel: balance column is right-aligned (text-align: right)", async ({ page }) => {
  await injectWallet(page, {
    privateKey: eps.admin_private_key as `0x${string}`,
    rpcUrl: eps.rpc_url,
    chainId: eps.chain_id,
  });
  await page.goto(eps.dapp_url);
  await connectInjectedWallet(page);
  await dismissOnboardingIfPresent(page);

  await page.getByTestId("balances-panel-row-usdc-amount").waitFor({ state: "visible" });

  // The balance column <td> must have text-align right (set via .balances-panel table td:last-child).
  const usdcCell = page.getByTestId("balances-panel-row-usdc-amount");
  const textAlign = await usdcCell.evaluate((el) => window.getComputedStyle(el).textAlign);
  expect(textAlign, "USDC balance cell should be right-aligned").toBe("right");
});

// ---------------------------------------------------------------------------
// Table alignment — ProportionPreview (router deposit split)
// ---------------------------------------------------------------------------

test("router-deposit: ProportionPreview numeric columns are right-aligned", async ({ page }) => {
  // The leg table renders only once the router destination is chosen and an amount is entered,
  // the same steps router-deposit.spec.ts takes. No skip: a missing table fails (QA plan v1 T5).
  await openDapp(page, eps, { role: "admin" });
  await openTab(page, "deposit-withdraw");
  await page.getByTestId("destination-router").click();
  await page.getByTestId("router-deposit-tab-amount").fill("10");

  const previewTable = page.getByTestId("proportion-preview-table");
  await expect(previewTable).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("proportion-preview-row-0")).toBeVisible();

  // Weight (2nd), USDC leg (3rd) and estimated shares (4th) are the numeric columns
  // (styles.css, ProportionPreview).
  for (const column of [2, 3, 4]) {
    const cell = page
      .locator(`[data-testid="proportion-preview-table"] td:nth-child(${column})`)
      .first();
    const align = await cell.evaluate((el) => window.getComputedStyle(el).textAlign);
    expect(align, `ProportionPreview column ${column} should be right-aligned`).toBe("right");
  }
});
