/**
 * Demo user-story CI suite — first-visitor browser session (issue #533).
 *
 * Exercises the public landing page as a completely unauthenticated visitor
 * would experience it: no wallet connected, no prior state. Asserts the three
 * pillars of the golden-path demo:
 *
 *   1. Price strip — all four cells show a numeric price (not 'unavailable',
 *      not a loading ellipsis '…').
 *   2. Vault TVL — at least one Active vault card shows a non-zero total_assets
 *      value (requires DappStack::boot auto-seeding from issue #532 and stub
 *      pools from issue #531).
 *   3. Console hygiene — zero JavaScript errors recorded during the landing-page
 *      session (inherits the _consoleGuard fixture from helpers/fixtures.ts).
 *
 * The spec runs against the existing suite-10 globalSetup devnet — no new
 * devnet boot is needed. The wallet provider IS injected (so wagmi can read
 * the real devnet RPC), but `connect: false` is passed so no wallet-connect
 * modal appears and the dapp renders the public visitor view.
 *
 * Canonical: docs/prd.md, docs/development/ci-suites.md §10, issue #533.
 */

import { test, expect } from "./helpers/fixtures";
import { loadEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

const PAIR_IDS = ["eth-usd", "weth-usdc", "cbbtc-usdc", "wsol-usdc"] as const;

test.describe("demo user stories: first-visitor landing-page session", () => {
  test("demo user stories price strip: all four price cells show a numeric value", async ({
    page,
  }) => {
    const endpoints = loadEndpoints();
    // Open the dapp landing page without connecting a wallet — exactly as a
    // first-time visitor would see it.
    await openDapp(page, endpoints, { connect: false });

    // The price strip section must be visible.
    await expect(page.getByTestId("landing-price-strip")).toBeVisible({ timeout: 30_000 });

    // Every cell must eventually show a numeric price — not 'unavailable' and
    // not the loading ellipsis '…'. We poll until all four cells are satisfied
    // or the timeout expires so we tolerate short initial-load latency.
    for (const id of PAIR_IDS) {
      const valueEl = page.getByTestId(`landing-price-cell-${id}-value`);
      await expect(valueEl).toBeVisible({ timeout: 30_000 });

      // Wait until the cell contains a parseable numeric value.
      await expect
        .poll(
          async () => {
            const text = (await valueEl.textContent()) ?? "";
            const trimmed = text.trim();
            // Reject loading states.
            if (trimmed === "" || trimmed === "…" || trimmed === "unavailable") return false;
            // Strip currency symbols and thousands separators before parsing.
            const numeric = Number(trimmed.replace(/[$,\s]/g, ""));
            return Number.isFinite(numeric) && numeric > 0;
          },
          { timeout: 60_000, intervals: [2_000] },
        )
        .toBe(true);

      // Also explicitly assert the cell does not show an error state.
      const text = (await valueEl.textContent()) ?? "";
      expect(
        text.trim(),
        `price cell ${id} must not show 'unavailable' — got: "${text.trim()}"`,
      ).not.toBe("unavailable");
      expect(
        text.trim(),
        `price cell ${id} must not show loading ellipsis — got: "${text.trim()}"`,
      ).not.toBe("…");
    }
  });

  test("demo user stories vault TVL: at least one vault card shows non-zero total_assets", async ({
    page,
  }) => {
    const endpoints = loadEndpoints();
    await openDapp(page, endpoints, { connect: false });

    // The vault cards section must be present.
    const vaultCards = page.getByTestId("landing-vault-cards");
    await expect(vaultCards).toBeVisible({ timeout: 30_000 });

    // Wait for Active vault cards to appear (DappStack::boot auto-seeding
    // should have produced at least three Active vaults).
    const activeCards = page.locator(
      '[data-testid="landing-vault-card"][data-vault-active="true"]',
    );
    await expect(activeCards).toHaveCount(3, { timeout: 30_000 });

    // At least one Active vault card must show a non-zero TVL value. The
    // explorer-indexer processes Deposit events asynchronously so we poll
    // until it catches up — VaultCards re-fetches every 15 s, so we will
    // see the update in the DOM without a page reload.
    const tvlCells = page.getByTestId("landing-vault-card-tvl");
    await expect(tvlCells.first()).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const count = await tvlCells.count();
          for (let i = 0; i < count; i++) {
            const text = (await tvlCells.nth(i).textContent()) ?? "";
            const trimmed = text.trim();
            // "0", "—", or blank all mean no TVL yet.
            if (trimmed !== "" && trimmed !== "—" && trimmed !== "0") return true;
          }
          return false;
        },
        {
          message:
            "at least one Active vault card must show a non-zero TVL after DappStack::boot auto-seeding (issue #532)",
          timeout: 60_000,
          intervals: [3_000],
        },
      )
      .toBe(true);
  });

  test("demo user stories console: zero JavaScript errors on the landing page", async ({
    page,
  }) => {
    const endpoints = loadEndpoints();
    // The _consoleGuard fixture (from helpers/fixtures.ts) automatically
    // captures all console.error / pageerror events and fails the test if any
    // are present. This test just needs to open the page and let it settle —
    // the fixture does the assertion.
    await openDapp(page, endpoints, { connect: false });

    // Allow the landing page to fully settle so in-flight async operations
    // that may emit console errors have time to resolve.
    await expect(page.getByTestId("landing-price-strip")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("landing-vault-cards")).toBeVisible({ timeout: 30_000 });

    // Small dwell time so deferred/lazy renders have a chance to fire any
    // errors before the _consoleGuard fixture asserts after the test body.
    await page.waitForTimeout(2_000);

    // Console-clean assertion is performed by the _consoleGuard fixture
    // after this test body returns — no explicit assertion needed here.
    test.info().annotations.push({
      type: "note",
      description:
        "Console hygiene verified by _consoleGuard fixture; any console.error or pageerror would fail this test.",
    });
  });
});
