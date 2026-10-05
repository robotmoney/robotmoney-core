/**
 * Playwright E2E — landing-page live DEX price strip (issue #482), run
 * against the Twin chain (a pinned lazy fork of real Base, core 1498) booted by
 * globalSetup. NO RPC mocks and NO useReadContract stubs: the dapp bundle
 * that ships is the bundle exercised here, reading pool slot0 over the real
 * devnet RPC (docs/prd.md#112-protocol-asset-vault).
 *
 * The pairs and their sanity bands are in
 * `testing/ethereum-testnet/config/price-strip-pairs.json`. The pin moves every run, so there is
 * no golden price: each cell must sit inside its [min_price, max_price] band, which still catches
 * wrong decimals, inverted pairs and a missing pool.
 */
import { test, expect } from "./helpers/fixtures";
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

interface PricePair {
  id: string;
  label: string;
  min_price: number;
  max_price: number;
}
interface PriceStripPairs {
  pairs: PricePair[];
}

function loadPairs(): PriceStripPairs {
  // tests/e2e -> repo root is four levels up (clients/dapp/tests/e2e).
  // Use import.meta.url instead of __dirname (ESM context).
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(thisDir, "../../../..");
  const file = path.join(repoRoot, "testing/ethereum-testnet/config/price-strip-pairs.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as PriceStripPairs;
}

/** The Twin chain pin, when the runner exports it (the twin-fork action does). The head is never below it. */
function pinBlock(): number {
  const n = Number(process.env.TWIN_PIN_BLOCK ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const PAIR_IDS = ["eth-usd", "weth-usdc", "cbbtc-usdc"] as const;

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

test("landing price strip prices sit inside their sanity bands", async ({ page }) => {
  await gotoLanding(page);
  const { pairs } = loadPairs();

  // All cells render.
  for (const id of PAIR_IDS) {
    await expect(page.getByTestId(`landing-price-cell-${id}`)).toBeVisible();
  }

  for (const pair of pairs) {
    const value = page.getByTestId(`landing-price-cell-${pair.id}-value`);
    await expect(value).not.toHaveText("unavailable");
    // Poll the numeric read so a transient loading/blank cell does not fail
    // the one-shot assertion (the price feed paints asynchronously).
    await expect
      .poll(
        async () => {
          const text = (await value.textContent()) ?? "";
          const numeric = Number(text.replace(/[$,\s]/g, ""));
          return Number.isFinite(numeric) && numeric >= pair.min_price && numeric <= pair.max_price;
        },
        {
          message: `landing price cell ${pair.id} must render inside [${pair.min_price}, ${pair.max_price}]`,
          timeout: 60_000,
          intervals: [2_000],
        },
      )
      .toBe(true);
  }
});

test("landing price strip shows block-number freshness chip", async ({ page }) => {
  await gotoLanding(page);

  // The section-level freshness chip eventually reports a block number at or after the Twin pin
  // (the chain keeps producing blocks past the fork point). Without the pin in the env only a
  // positive block is guaranteed.
  const minBlock = pinBlock();
  const blockPredicate = async () =>
    parseBlock(await page.getByTestId("landing-price-strip-freshness").textContent());
  await expect.poll(blockPredicate, { timeout: 60_000 }).toBeGreaterThan(Math.max(0, minBlock - 1));

  // Each cell carries its own block chip with the same property.
  for (const id of PAIR_IDS) {
    const block = parseBlock(
      await page.getByTestId(`landing-price-cell-${id}-block`).textContent(),
    );
    expect(block).not.toBeNull();
    expect(block as number).toBeGreaterThan(Math.max(0, minBlock - 1));
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
