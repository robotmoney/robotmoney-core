/**
 * Playwright E2E — consensus receipts against the full-stack devnet
 * (issue #1294).
 *
 * Issue #1247 delivered the consensus receipt anchor end to end, but its test
 * plan item "dapp e2e against the full-stack devnet" was NOT delivered because
 * the devnet carried none of the path (no InvestmentCommitteePolicy /
 * ConsensusRebalanceReceipt, no INDEXER_CONSENSUS_RECEIPT, no served
 * payload_uri). This spec closes that gap: it asserts the four rendered states
 * the unit tests cover at the rendering layer are actually wired end to end —
 * verified / unverified, released / recorded-not-released, and applied /
 * not-applied — against the live smoke-test devnet.
 *
 * The smoke-test `--full-stack` harness now deploys the committee + receipt
 * contracts, seeds two fixture receipts (one that verifies and is released and
 * whose weights match the live router split; one with a deliberately wrong
 * digest that never releases and whose weights differ), configures
 * INDEXER_CONSENSUS_RECEIPT, and serves the payload fixture bytes from the
 * `receipt-fixtures` compose service. The consensus-receipts tab is on the main
 * dapp surface (`dapp-surface-tabs`), not the AdminFlow tabs.
 *
 * Canonical: docs/architecture.md §4.9, issue #1247, issue #1294.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

test.describe("consensus receipts — full-stack devnet e2e", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("the four receipt states render distinctly against the live devnet", async ({
    page,
  }) => {
    await openDapp(page, endpoints, { role: "admin" });

    // The consensus-receipts tab is on the main dapp surface (not AdminFlow).
    await page.getByTestId("tab-consensus-receipts").click();
    const panel = page.getByTestId("tabpanel-consensus-receipts");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // The smoke-test harness seeds exactly two receipts (issue #1294).
    const list = panel.getByTestId("consensus-receipt-list");
    await expect(list).toBeVisible({ timeout: 30_000 });
    const rows = list.locator("li");
    await expect(rows).toHaveCount(2, { timeout: 30_000 });

    // (1) Verified state — receipt-a's digest matches the re-fetched payload.
    await expect(panel.getByText(/Verified — the published payload hashes to the anchored digest/)).toBeVisible();
    // (2) Unverified state — receipt-b's on-chain digest is deliberately wrong.
    await expect(panel.getByText(/Unverified — the published payload does not hash to the anchored digest/)).toBeVisible();

    // (3) Released vs recorded-not-released.
    await expect(panel.getByText(/^Released\b/)).toBeVisible();
    await expect(panel.getByText("Recorded, not released")).toBeVisible();

    // (4) Applied vs not-applied, against the live router split.
    await expect(panel.getByText(/Applied — live router weights match this recommendation/)).toBeVisible();
    await expect(panel.getByText(/Not applied — live router weights differ from this recommendation/)).toBeVisible();
  });
});
