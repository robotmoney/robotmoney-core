/**
 * Playwright E2E — consensus receipts, against a REAL frontend-generated
 * receipt (QA step 3.9; issue #1294 originally).
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 * This spec used to assert against the two receipts the smoke-test harness
 * SEEDS: core-owned fixture payloads served by the `receipt-fixtures` compose
 * service, one deliberately verifying and one deliberately not. That proved the
 * four rendered states were wired, but it proved them against bytes core itself
 * wrote, so the cross-repo interface — the part Fusion is actually about — was
 * never exercised at this layer. `project-fusion.md` §12.6 (AC-E2E-*) requires
 * ONE retained run in which a real robotmoney-frontend receipt travels to chain
 * and back, and the QA tasklist's step 3.9 says in as many words: replace the
 * seeded `dapp-receipt-fixtures` path with the real frontend artifact.
 *
 * So the subject is now the receipt the run anchored, named by environment:
 *   FUSION_DAPP_URL        the dapp under test (defaults to the devnet fixture)
 *   FUSION_RECEIPT_ID      the anchored receipt id (bytes32, 0x-prefixed)
 *   FUSION_RECEIPT_URL     the public payload_uri anchored beside it
 *   FUSION_EXPECTED_SIGNATURES   how many analyst signatures the payload carries
 *   FUSION_EXPECT_RELEASED       "true" once the admin release has landed
 *
 * It NEVER falls back to the seeded fixtures: with no receipt named, it SKIPS
 * with the reason stated, because a pass against core's own fixtures would be
 * the exact evidence this step exists to stop us reporting.
 *
 * Canonical: docs/architecture.md §4.9; project-fusion.md §12.4 AC-CORE-08,
 * §12.6 AC-E2E-02/03.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints } from "./helpers/devnet";

const RECEIPT_ID = process.env.FUSION_RECEIPT_ID ?? "";
const RECEIPT_URL = process.env.FUSION_RECEIPT_URL ?? "";
const EXPECTED_SIGNATURES = Number(process.env.FUSION_EXPECTED_SIGNATURES ?? "3");
const EXPECT_RELEASED = (process.env.FUSION_EXPECT_RELEASED ?? "true") === "true";

function dappUrl(): string {
  if (process.env.FUSION_DAPP_URL) return process.env.FUSION_DAPP_URL;
  return loadEndpoints().dapp_url;
}

test.describe("consensus receipts — the real frontend artifact, end to end", () => {
  test.skip(
    !RECEIPT_ID || !RECEIPT_URL,
    "FUSION_RECEIPT_ID and FUSION_RECEIPT_URL must name the receipt this run anchored. " +
      "This spec deliberately has no seeded-fixture fallback: passing against core's own " +
      "fixture payloads would not be evidence that a robotmoney-frontend receipt survives " +
      "the round trip (QA step 3.9).",
  );

  test("the anchored frontend receipt renders with the correct states, counts and labelling", async ({
    page,
  }) => {
    await page.goto(dappUrl(), { waitUntil: "domcontentloaded" });
    await page.getByTestId("tab-consensus-receipts").click();

    const panel = page.getByTestId("consensus-receipt-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // The surface must say what the commitment is NOT, before any state is read.
    const disclosure = panel.getByTestId("consensus-receipt-disclosure");
    await expect(disclosure).toContainText("does not record a per-analyst on-chain approval");
    await expect(disclosure).toContainText("signalling-only");
    await expect(disclosure).toContainText("moves no funds and sets no router weight");

    await expect(panel.getByTestId("consensus-receipt-loading")).toHaveCount(0, {
      timeout: 60_000,
    });

    const row = panel.getByTestId(`consensus-receipt-${RECEIPT_ID}`);
    await expect(row).toBeVisible({ timeout: 60_000 });

    // THE REPLACEMENT, ASSERTED: the seeded fixture payloads are not what is
    // being rendered. `receipt-fixtures` served its bytes from the dapp docker
    // network; the subject here is a public robotmoney-frontend URL.
    await expect(row.locator("a")).toHaveAttribute("href", RECEIPT_URL);
    expect(RECEIPT_URL).not.toContain("receipt-fixtures");

    // Verified — the indexer independently re-fetched the payload URL and
    // reproduced the anchored digest. This is the indexer's own verdict, not
    // the publisher's `verified` field.
    await expect(panel.getByTestId(`verification-${RECEIPT_ID}`)).toHaveText(
      "Verified — the published payload hashes to the anchored digest",
    );

    // Released vs recorded-only.
    const release = panel.getByTestId(`release-${RECEIPT_ID}`);
    if (EXPECT_RELEASED) {
      await expect(release).toHaveText(/^Released\b/);
    } else {
      await expect(release).toHaveText("Recorded, not released");
    }

    // Applied vs not-applied. Under D8 nothing is applied, and the answer must
    // be that definite sentence — never "cannot determine", which is what the
    // surface said while it could not read the published envelope.
    await expect(panel.getByTestId(`applied-${RECEIPT_ID}`)).toHaveText(
      "Not applied — live router weights differ from this recommendation",
    );

    // The signature count is a PAYLOAD count and is labelled as one.
    await expect(panel.getByTestId(`signatures-${RECEIPT_ID}`)).toHaveText(
      `Payload signatures: ${EXPECTED_SIGNATURES} off-chain analyst signature` +
        `${EXPECTED_SIGNATURES === 1 ? "" : "s"} carried in the payload (not on-chain approvals)`,
    );
  });
});
