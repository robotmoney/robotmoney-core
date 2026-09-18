/**
 * Playwright E2E — consensus receipts, the ALWAYS-RUNNING coverage
 * (QA finding T14; restores the spec `b3ed4dc1` replaced).
 *
 * WHY THIS FILE EXISTS
 * `consensus-receipts.spec.ts` asserts against the receipt a Fusion QA run
 * really anchored, named by `FUSION_RECEIPT_ID` / `FUSION_RECEIPT_URL`. That is
 * the right subject for the cross-repo round trip — and it is deliberately
 * fallback-free, so with no receipt named it skips. Nothing in `.github/`, in
 * `playwright.config.ts`, or in the smoke-test harness sets either variable, so
 * between `b3ed4dc1` and this change `AC-CORE-08`'s claim — "browser tests cover
 * all four state dimensions and the required explanatory language" — executed on
 * ZERO runs while reporting skipped-green on every PR.
 *
 * This spec is the standing gate underneath it. Its subject is the pair of
 * receipts the `--full-stack` smoke-test harness already seeds unconditionally
 * (`Fixture::seed_consensus_receipts`, served by the `receipt-fixtures` compose
 * service), so it needs no environment at all and runs on every suite-10 run:
 *
 *   receipt-a — digest matches its payload, released, weights match the live
 *               8500/500/500/500 router split  ⇒ Verified · Released · Applied
 *   receipt-b — deliberately wrong on-chain digest, never released, weights
 *               differ                          ⇒ Unverified · Recorded, not
 *                                                 released · Not applied
 *
 * Between them the two rows exercise BOTH poles of all four state dimensions
 * (verification, release, application, payload-signature count) plus the
 * required explanatory language. The seeded payload bytes are core's own, which
 * is exactly why this spec does not replace the real-artifact one: it proves the
 * rendering contract is wired, never that a robotmoney-frontend receipt survives
 * the round trip. Both run; neither substitutes for the other.
 *
 * Canonical: docs/architecture.md §4.9; project-fusion.md §12.4 AC-CORE-08.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";

test.describe("consensus receipts — seeded devnet fixtures (always runs)", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("both poles of all four state dimensions render, with the required language", async ({
    page,
  }) => {
    await page.goto(endpoints.dapp_url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("tab-consensus-receipts").click();

    const panel = page.getByTestId("consensus-receipt-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // REQUIRED EXPLANATORY LANGUAGE — what the commitment is NOT. Asserted
    // before any state is read, because a reader who misses this sentence
    // misreads every state below it.
    const disclosure = panel.getByTestId("consensus-receipt-disclosure");
    await expect(disclosure).toContainText("does not record a per-analyst on-chain approval");
    await expect(disclosure).toContainText("signalling-only");
    await expect(disclosure).toContainText("moves no funds and sets no router weight");

    await expect(panel.getByTestId("consensus-receipt-loading")).toHaveCount(0, {
      timeout: 60_000,
    });

    // The harness seeds exactly two receipts; a third would mean this devnet is
    // not the one this spec's expectations were written against.
    const list = panel.getByTestId("consensus-receipt-list");
    await expect(list).toBeVisible({ timeout: 60_000 });
    await expect(list.locator("li")).toHaveCount(2, { timeout: 60_000 });

    // DIMENSION 1 — verification. The indexer independently re-fetched each
    // payload_uri and re-hashed it; this is its verdict, not the publisher's.
    await expect(
      panel.getByText("Verified — the published payload hashes to the anchored digest"),
    ).toBeVisible();
    await expect(
      panel.getByText("Unverified — the published payload does not hash to the anchored digest"),
    ).toBeVisible();

    // DIMENSION 2 — release.
    await expect(panel.getByText(/^Released\b/)).toBeVisible();
    await expect(panel.getByText("Recorded, not released")).toBeVisible();

    // DIMENSION 3 — application against the LIVE router weights.
    await expect(
      panel.getByText("Applied — live router weights match this recommendation"),
    ).toBeVisible();
    await expect(
      panel.getByText("Not applied — live router weights differ from this recommendation"),
    ).toBeVisible();

    // DIMENSION 4 — the signature count is a PAYLOAD count and is labelled as
    // one, never as an on-chain approval count. receipt-a carries 2 analyst
    // signatures, receipt-b carries 1 (so the singular/plural wording is
    // exercised too).
    await expect(
      panel.getByText(
        "Payload signatures: 2 off-chain analyst signatures carried in the payload " +
          "(not on-chain approvals)",
      ),
    ).toBeVisible();
    await expect(
      panel.getByText(
        "Payload signatures: 1 off-chain analyst signature carried in the payload " +
          "(not on-chain approvals)",
      ),
    ).toBeVisible();
  });
});
