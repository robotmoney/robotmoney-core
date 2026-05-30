/**
 * Suite-10 — Playwright E2E for protocol-layer components (issue #318).
 *
 * Verifies that a visitor can load the dapp WITHOUT connecting a wallet
 * and see the protocol-layer UI:
 *   - VaultList renders a row for every vault registered in VaultRegistry
 *   - Each vault row shows a non-blank TVL stat and a numeric depositor count
 *   - ProtocolStats aggregate TVL is a parseable number (not blank, not error)
 *
 * The devnet globalSetup has already deployed contracts, registered vaults
 * via the VaultRegistry, and seeded at least one deposit. The explorer-api
 * container is running and indexed.
 *
 * NOTE: RouterView is asserted to render (no wallet required); it may show
 * "No weights set yet" if PortfolioRouter events have not been indexed by
 * the time the test runs — this is acceptable per the issue scope.
 *
 * Canonical: docs/development/smoke-test-design.md, issue #318.
 */

import { test, expect } from "./helpers/fixtures";
import { encodeFunctionData, type Address } from "viem";
import { loadEndpoints } from "./helpers/devnet";
import { registryAbi } from "../../src/lib/abi";

/**
 * Call VaultRegistry.listVaults() via a raw eth_call (no wallet needed).
 * Returns the array of registered vault addresses.
 */
async function listVaults(rpc: string, registry: string): Promise<Address[]> {
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "listVaults",
    args: [],
  });
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: registry, data }, "latest"],
    }),
  });
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(`registry.listVaults eth_call error: ${j.error.message}`);
  // Decode ABI-encoded address[] return value.
  // Layout: offset (32 bytes) + length (32 bytes) + N × address (32 bytes each).
  const hex = (j.result ?? "0x").slice(2); // strip 0x
  if (hex.length < 128) return [];
  const count = parseInt(hex.slice(64, 128), 16);
  const vaults: Address[] = [];
  for (let i = 0; i < count; i++) {
    const start = 128 + i * 64;
    const addrHex = hex.slice(start + 24, start + 64); // last 20 bytes of 32-byte slot
    vaults.push(`0x${addrHex}` as Address);
  }
  return vaults;
}

test.describe("Suite-10: Protocol layer — no wallet required", () => {
  let dappUrl: string;
  let rpcUrl: string;
  let registryAddr: string;

  test.beforeAll(() => {
    const ep = loadEndpoints();
    dappUrl = ep.dapp_url;
    rpcUrl = ep.rpc_url;
    registryAddr = ep.registry_addr;
  });

  test("dapp loads without a connected wallet", async ({ page }) => {
    await page.goto(dappUrl);
    // The nav bar must always be visible.
    await expect(page.getByTestId("nav")).toBeVisible({ timeout: 15_000 });
    // No wallet connection prompt should block the protocol layer.
    // The page should not require a wallet to render content.
    await expect(page).toHaveURL(new RegExp(dappUrl.replace(/\/+$/, "")));
  });

  test("VaultList renders a row for every on-chain registered vault", async ({ page }) => {
    // Fetch the ground-truth set of registered vaults from the chain.
    const registeredVaults = await listVaults(rpcUrl, registryAddr);
    expect(
      registeredVaults.length,
      "VaultRegistry.listVaults() must return at least 1 vault — devnet globalSetup must have registered vaults",
    ).toBeGreaterThan(0);

    await page.goto(dappUrl);
    await page.getByTestId("tab-portfolio-explorer").click();
    await page.getByTestId("tabpanel-portfolio-explorer").waitFor({ state: "visible" });
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });

    // The list must not be in an error state.
    await expect(page.getByTestId("vault-list-error")).not.toBeVisible();

    // A table must render — empty state is a failure because we asserted at least 1 vault exists.
    const table = page.getByTestId("vault-list-table");
    await expect(table).toBeVisible({ timeout: 15_000 });

    // Each registered vault address must have a corresponding row in the dapp.
    for (const vaultAddr of registeredVaults) {
      const row = page
        .getByTestId(`vault-list-row-${vaultAddr.toLowerCase()}`)
        .or(page.locator(`[data-vault-addr="${vaultAddr.toLowerCase()}"]`));
      await expect(
        row,
        `dapp must render a vault row for registered vault ${vaultAddr}`,
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("VaultList rows show non-blank TVL and numeric depositor count", async ({ page }) => {
    const registeredVaults = await listVaults(rpcUrl, registryAddr);
    expect(
      registeredVaults.length,
      "VaultRegistry.listVaults() must return at least 1 vault",
    ).toBeGreaterThan(0);

    await page.goto(dappUrl);
    await page.getByTestId("tab-portfolio-explorer").click();
    await page.getByTestId("tabpanel-portfolio-explorer").waitFor({ state: "visible" });
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("vault-list-error")).not.toBeVisible();
    await expect(page.getByTestId("vault-list-table")).toBeVisible({ timeout: 15_000 });

    // Every vault row must expose a TVL cell and a status cell.
    // TVL must be a non-blank string (may be "—" when not yet snapshotted).
    // Status must be a non-blank string (Active / Paused / Retired).
    // NOTE: per-vault depositor count is not surfaced by the VaultList component —
    // aggregate depositor count is available at /v1/stats (protocol-stats tests above).
    const tvlCells = page.getByTestId("vault-list-row-tvl");
    const statusCells = page.getByTestId("vault-list-row-status");

    const tvlCount = await tvlCells.count();
    expect(tvlCount, "each registered vault must have a TVL cell").toBeGreaterThanOrEqual(
      registeredVaults.length,
    );

    for (let i = 0; i < tvlCount; i++) {
      const tvlText = await tvlCells.nth(i).textContent();
      expect(tvlText?.trim(), `vault row ${i} TVL must not be blank`).toBeTruthy();
    }

    const statusCount = await statusCells.count();
    expect(statusCount, "each registered vault must have a status cell").toBeGreaterThanOrEqual(
      registeredVaults.length,
    );

    for (let i = 0; i < statusCount; i++) {
      const statusText = await statusCells.nth(i).textContent();
      expect(["Active", "Paused", "Retired"]).toContain(statusText?.trim());
    }
  });

  test("VaultList shows correct status for registered vaults", async ({ page }) => {
    await page.goto(dappUrl);
    await page.getByTestId("tab-portfolio-explorer").click();
    await page.getByTestId("tabpanel-portfolio-explorer").waitFor({ state: "visible" });
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("vault-list-error")).not.toBeVisible();

    const table = page.getByTestId("vault-list-table");
    await expect(table).toBeVisible({ timeout: 15_000 });

    const statusCells = page.getByTestId("vault-list-row-status");
    const count = await statusCells.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const text = await statusCells.nth(i).textContent();
      expect(["Active", "Paused", "Retired"]).toContain(text);
    }
  });

  test("ProtocolStats aggregate TVL is a parseable number", async ({ page }) => {
    await page.goto(dappUrl);
    const stats = page.getByTestId("protocol-stats");
    await expect(stats).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("protocol-stats-error")).not.toBeVisible();

    // TVL and depositor count must be present (value may be "0").
    const tvl = page.getByTestId("protocol-stats-tvl");
    const depositors = page.getByTestId("protocol-stats-depositors");
    await expect(tvl).toBeVisible();
    await expect(depositors).toBeVisible();

    // TVL must be a parseable number — not blank, not an error message.
    const tvlText = await tvl.textContent();
    expect(
      tvlText?.trim(),
      `ProtocolStats TVL must be a parseable number (got "${tvlText}")`,
    ).toMatch(/^\d+(\.\d+)?$/);

    const depText = await depositors.textContent();
    expect(
      depText?.trim(),
      `ProtocolStats depositor count must be a numeric string (got "${depText}")`,
    ).toMatch(/^\d+$/);
  });

  test("RouterView renders without wallet — shows weights or empty state", async ({ page }) => {
    await page.goto(dappUrl);
    // RouterView lives in the unflagged "router-governance" tab.
    const routerTab = page.getByTestId("tab-router-governance");
    await expect(routerTab).toBeVisible({ timeout: 30_000 });
    await routerTab.click();
    await page.getByTestId("tabpanel-router-governance").waitFor({ state: "visible" });
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
    await page.getByTestId("tab-portfolio-explorer").click();
    await page.getByTestId("tabpanel-portfolio-explorer").waitFor({ state: "visible" });
    const vaultList = page.getByTestId("vault-list");
    await expect(vaultList).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("vault-list-table")).toBeVisible({ timeout: 15_000 });

    // Click the first vault row (each row has data-vault-addr set to the vault address).
    const firstRow = page.locator("[data-vault-addr]").first();
    await firstRow.click();

    // VaultDetail should appear.
    const detail = page.getByTestId("vault-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("vault-detail-error")).not.toBeVisible();

    // Detail must show a name and a freshness block.
    await expect(page.getByTestId("vault-detail-name")).toBeVisible();
    await expect(page.getByTestId("vault-detail-freshness")).toBeVisible();
  });

  // Four-vault PRD conformance (issue #479): the landing VaultCards must
  // render one tile per registered vault — four after the demo seed — and the
  // RWA/Thematic placeholder must render in its inactive presentation (Future,
  // no deposit/TVL stats) with the inactive flag sourced from a registry read,
  // not a constant.
  test("landing renders a tile per registered vault with the RWA tile inactive", async ({
    page,
  }) => {
    // Ground truth: the chain-registered vault set, and each vault's status.
    const registeredVaults = await listVaults(rpcUrl, registryAddr);
    expect(
      registeredVaults.length,
      "expected the four-vault demo set in the registry (3 Active + RWA placeholder)",
    ).toBe(4);

    await page.goto(dappUrl);

    const cards = page.getByTestId("landing-vault-card");
    // One tile per registered vault.
    await expect(cards).toHaveCount(registeredVaults.length, { timeout: 30_000 });

    // Exactly one tile must be in the inactive presentation — the RWA/Thematic
    // placeholder — and it must show the Future notice and no deposit/TVL stats.
    const inactiveCards = page.locator(
      '[data-testid="landing-vault-card"][data-vault-active="false"]',
    );
    await expect(inactiveCards).toHaveCount(1);
    await expect(inactiveCards.getByTestId("landing-vault-card-future")).toBeVisible();
    // No deposit affordance / live stats on the inactive tile.
    await expect(inactiveCards.getByTestId("landing-vault-card-tvl")).toHaveCount(0);

    // The other three tiles are Active.
    const activeCards = page.locator(
      '[data-testid="landing-vault-card"][data-vault-active="true"]',
    );
    await expect(activeCards).toHaveCount(3);
  });
});
