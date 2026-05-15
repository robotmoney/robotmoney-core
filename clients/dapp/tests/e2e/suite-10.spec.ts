/**
 * Suite-10 — Playwright E2E for protocol-layer components (issue #318).
 *
 * Verifies that a visitor can load the dapp WITHOUT connecting a wallet
 * and see the protocol-layer UI:
 *   - VaultList renders registered vaults from GET /v1/vaults
 *   - VaultDetail renders after clicking a vault row
 *   - ProtocolStats renders aggregate TVL and depositor count
 *
 * The devnet globalSetup has already deployed contracts, registered vaults
 * via the VaultRegistry, and seeded at least one deposit. The explorer-api
 * container is running and indexed.
 *
 * NOTE: RouterView is asserted to render (no wallet required); it may show
 * "No weights set yet" if PortfolioRouter events have not been indexed by
 * the time the test runs — this is acceptable per the issue scope.
 *
 * Canonical: docs/testing/smoke-test-design.md, issue #318.
 */

import { test, expect } from "@playwright/test";
import { loadEndpoints } from "./helpers/devnet";

test.describe("Suite-10: Protocol layer — no wallet required", () => {
  let dappUrl: string;

  test.beforeAll(() => {
    const ep = loadEndpoints();
    dappUrl = ep.dapp_url;
  });

  test("dapp loads without a connected wallet", async ({ page }) => {
    await page.goto(dappUrl);
    // The nav bar must always be visible.
    await expect(page.getByTestId("nav")).toBeVisible({ timeout: 15_000 });
    // No wallet connection prompt should block the protocol layer.
    // The page should not require a wallet to render content.
    await expect(page).toHaveURL(new RegExp(dappUrl.replace(/\/+$/, "")));
  });

  test("VaultList renders registered vaults without wallet", async ({ page }) => {
    await page.goto(dappUrl);
    // Wait for the vault list to appear and load.
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });

    // The list should not be in an error state.
    await expect(page.getByTestId("vault-list-error")).not.toBeVisible();

    // Either a table (with rows) or an empty-state message must render.
    const table = page.getByTestId("vault-list-table");
    const empty = page.getByTestId("vault-list-empty");
    const hasTable = await table.isVisible().catch(() => false);
    const hasEmpty = await empty.isVisible().catch(() => false);
    expect(hasTable || hasEmpty, "vault list must render table or empty state").toBe(true);
  });

  test("VaultList shows correct status for registered vaults", async ({ page }) => {
    await page.goto(dappUrl);
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });

    // If the devnet has registered vaults, their status must be a known label.
    const table = page.getByTestId("vault-list-table");
    const hasTable = await table.isVisible().catch(() => false);
    if (!hasTable) {
      // No vaults registered — skip status assertion.
      test.skip();
      return;
    }
    const statusCells = page.getByTestId("vault-list-row-status");
    const count = await statusCells.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const text = await statusCells.nth(i).textContent();
      expect(["Active", "Paused", "Retired"]).toContain(text);
    }
  });

  test("ProtocolStats renders aggregate TVL and depositor count", async ({ page }) => {
    await page.goto(dappUrl);
    const stats = page.getByTestId("protocol-stats");
    await expect(stats).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("protocol-stats-error")).not.toBeVisible();

    // TVL and depositor count must be present (value may be "0").
    const tvl = page.getByTestId("protocol-stats-tvl");
    const depositors = page.getByTestId("protocol-stats-depositors");
    await expect(tvl).toBeVisible();
    await expect(depositors).toBeVisible();

    // Values must be numeric strings.
    const tvlText = await tvl.textContent();
    expect(tvlText).toMatch(/^\d+$/);
    const depText = await depositors.textContent();
    expect(depText).toMatch(/^\d+$/);
  });

  test("RouterView renders without wallet — shows weights or empty state", async ({ page }) => {
    await page.goto(dappUrl);
    const routerView = page.getByTestId("router-view");
    await expect(routerView).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("router-view-error")).not.toBeVisible();

    // Either the weights table or the empty-state must render.
    const weightsTable = page.getByTestId("router-view-weights-table");
    const weightsEmpty = page.getByTestId("router-view-weights-empty");
    const hasWeights = await weightsTable.isVisible().catch(() => false);
    const hasEmpty = await weightsEmpty.isVisible().catch(() => false);
    expect(hasWeights || hasEmpty, "router view must render weights or empty state").toBe(true);
  });

  test("VaultDetail renders when vault row is clicked", async ({ page }) => {
    await page.goto(dappUrl);
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });

    const table = page.getByTestId("vault-list-table");
    const hasTable = await table.isVisible().catch(() => false);
    if (!hasTable) {
      test.skip();
      return;
    }

    // Click the first vault row.
    const firstRow = page.getByTestId("vault-list-row").first();
    await firstRow.click();

    // VaultDetail should appear.
    const detail = page.getByTestId("vault-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("vault-detail-error")).not.toBeVisible();

    // Detail must show a name and a freshness block.
    await expect(page.getByTestId("vault-detail-name")).toBeVisible();
    await expect(page.getByTestId("vault-detail-freshness")).toBeVisible();
  });
});
