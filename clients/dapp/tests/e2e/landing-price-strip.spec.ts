/**
 * Playwright E2E — landing-page live DEX price strip (issue #482), run
 * against the smoke-test full-stack forked-Base devnet booted by
 * globalSetup. NO RPC mocks and NO useReadContract stubs: the dapp bundle
 * that ships is the bundle exercised here, reading pool slot0 over the real
 * devnet RPC (docs/prd.md#112-protocol-asset-vault).
 *
 * Expected prices are pinned in
 * `testing/ethereum-testnet/config/expected-prices.json`. When that fixture's
 * `captured` flag is false the magnitude assertions are skipped (the pools are
 * not yet archive-pinned) but the strip-renders / freshness-chip / per-cell
 * isolation assertions always run. When `captured` is true each cell's numeric
 * value is asserted to match the fixture within `tolerance_pct`.
 */
import { test, expect } from "./helpers/fixtures";
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

interface ExpectedPair {
  id: string;
  label: string;
  expected_price: number | null;
}
interface ExpectedPrices {
  fork_block: number;
  tolerance_pct: number;
  captured: boolean;
  pairs: ExpectedPair[];
}

function loadExpectedPrices(): ExpectedPrices {
  // tests/e2e -> repo root is four levels up (clients/dapp/tests/e2e).
  // Use import.meta.url instead of __dirname (ESM context).
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(thisDir, "../../../..");
  const file = path.join(repoRoot, "testing/ethereum-testnet/config/expected-prices.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as ExpectedPrices;
}

const PAIR_IDS = ["eth-usd", "weth-usdc", "cbbtc-usdc", "wsol-usdc"] as const;

async function gotoLanding(page: Page): Promise<void> {
  // The price strip is part of the public landing overview — no wallet
  // connect required. Inject the devnet chain so wagmi reads the real RPC,
  // but skip the connect flow.
  await openDapp(page, loadEndpoints(), { connect: false });
  await expect(page.getByTestId("landing-price-strip")).toBeVisible();
}

/** Parse a "Block N" chip into its numeric block, or null while pending. */
function parseBlock(text: string | null): number | null {
  const m = (text ?? "").match(/Block\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

test("landing price strip matches Base mainnet at fork block", async ({ page }) => {
  await gotoLanding(page);
  const expected = loadExpectedPrices();

  // All four cells render.
  for (const id of PAIR_IDS) {
    await expect(page.getByTestId(`landing-price-cell-${id}`)).toBeVisible();
  }

  if (!expected.captured) {
    test.info().annotations.push({
      type: "note",
      description:
        "expected-prices fixture not yet archive-pinned (captured=false); " +
        "magnitude assertions skipped. Pin real values to enable.",
    });
    return;
  }

  for (const pair of expected.pairs) {
    const value = page.getByTestId(`landing-price-cell-${pair.id}-value`);
    await expect(value).not.toHaveText("unavailable");
    const text = (await value.textContent()) ?? "";
    const numeric = Number(text.replace(/[$,\s]/g, ""));
    expect(Number.isFinite(numeric)).toBeTruthy();
    const exp = pair.expected_price as number;
    const driftPct = (Math.abs(numeric - exp) / exp) * 100;
    expect(driftPct).toBeLessThanOrEqual(expected.tolerance_pct);
  }
});

test("landing price strip shows block-number freshness chip", async ({ page }) => {
  await gotoLanding(page);
  const expected = loadExpectedPrices();

  // The section-level freshness chip eventually reports a positive block
  // number. When `captured` is true and the devnet is a real archive fork,
  // the block is also at or after the pinned fork block (the devnet keeps
  // producing blocks past the fork). When `captured` is false the devnet
  // starts from its own genesis (pinned: false) so only a positive block
  // is guaranteed.
  const blockPredicate = async () =>
    parseBlock(await page.getByTestId("landing-price-strip-freshness").textContent());
  if (expected.captured) {
    await expect
      .poll(blockPredicate, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(expected.fork_block);
  } else {
    await expect.poll(blockPredicate, { timeout: 60_000 }).toBeGreaterThan(0);
  }

  // Each cell carries its own block chip with the same property.
  for (const id of PAIR_IDS) {
    const block = parseBlock(
      await page.getByTestId(`landing-price-cell-${id}-block`).textContent(),
    );
    expect(block).not.toBeNull();
    if (expected.captured) {
      expect(block as number).toBeGreaterThanOrEqual(expected.fork_block);
    } else {
      expect(block as number).toBeGreaterThan(0);
    }
  }
});

test("landing price strip isolates per-cell errors against real fork", async ({ page }) => {
  await gotoLanding(page);

  // Per-cell isolation is structural: each cell is an independent read whose
  // failure sets data-cell-unavailable="true" and renders 'unavailable' on
  // that cell only. Drive the assertion against whichever cell the real fork
  // cannot serve (a pool absent from the devnet's ingested address set), and
  // assert it does NOT blank the other cells: every other cell is either a
  // rendered value or its own independent 'unavailable', never empty.
  const unavailableCells: string[] = [];
  for (const id of PAIR_IDS) {
    const cell = page.getByTestId(`landing-price-cell-${id}`);
    const flag = await cell.getAttribute("data-cell-unavailable");
    const value = (await page.getByTestId(`landing-price-cell-${id}-value`).textContent()) ?? "";
    // No cell is ever blank — it shows a value, a loading ellipsis, or
    // 'unavailable'.
    expect(value.trim().length).toBeGreaterThan(0);
    if (flag === "true") {
      expect(value).toBe("unavailable");
      unavailableCells.push(id);
    }
  }

  // The strip itself always renders regardless of any per-cell failure.
  await expect(page.getByTestId("landing-price-strip")).toBeVisible();
  test.info().annotations.push({
    type: "note",
    description: `per-cell unavailable on fork: [${unavailableCells.join(", ")}]`,
  });
});
