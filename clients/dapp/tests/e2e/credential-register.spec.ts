/**
 * Playwright E2E — register-existing-address credential flow.
 *
 * Runs against the smoke-test full-stack devnet. Acceptance criterion
 * source: issue #150 AC §1–§4.
 *
 * Invariants verified here:
 *   1. Filling a valid externally-supplied agent address plus a
 *      share-receiver surfaces structured commitAuthorization and
 *      revealAuthorization previews (the calls the wallet signs, QA plan U4).
 *   2. The wallet signing button is only enabled after the structured
 *      preview renders.
 *   3. The config-export panel appears (register flow emits a config
 *      the real rmpc loader accepts; the TOML round-trip is covered
 *      by `clients/rust-payment-client/tests/dapp_toml_roundtrip.rs`).
 *
 * The dapp never generates private keys in the browser — see
 * docs/technical/dapp-credential-decisions.md §3.1 — so there is no
 * keygen UI surface to assert against.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

let endpoints: DevnetEndpoints;
let AGENT_ADDRESS: string;
let SHARE_RECEIVER: string;

test.beforeAll(() => {
  endpoints = loadEndpoints();
  AGENT_ADDRESS = endpoints.agent_addr;
  SHARE_RECEIVER = endpoints.share_receiver_addr;
});

test.describe("register-existing-address flow — UI invariants", () => {
  test("structured commit and reveal previews render for a valid externally-supplied address", async ({
    page,
  }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    // The share receiver is always the signing wallet (ACL-9).
    await page.getByTestId("shareReceiver-input").fill(endpoints.admin_addr);
    // The owner selects the vault the agent may deposit into (issue 1889); nothing is implied.
    await page.getByTestId("destination-extra").fill(endpoints.vault_addr);
    await page.getByTestId("authorize-freeze").click();

    const preview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(preview).toBeVisible();

    // QA plan U4: the previews name the calls the wallet signs.
    const commitPreview = page.getByTestId("authorize-commit-preview");
    await expect(commitPreview.getByTestId("tx-preview-fn")).toHaveText("commitAuthorization");
    const revealPreview = page.getByTestId("authorize-reveal-preview");
    await expect(revealPreview.getByTestId("tx-preview-fn")).toHaveText("revealAuthorization");
    await expect(revealPreview.getByTestId("tx-preview-effect")).toContainText("AGENT_ROLE");

    const refusals = await page.locator('[data-testid="refusal-reason"]').count();
    expect(refusals).toBe(0);
  });

  test("authorize signing button is disabled until structured preview is valid", async ({
    page,
  }) => {
    await openDapp(page, endpoints);

    const button = page.getByTestId("authorize-freeze");
    await expect(button).toBeDisabled();

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await expect(button).toBeDisabled();

    // A receiver other than the signing wallet keeps the freeze closed (ACL-9).
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);
    await expect(button).toBeDisabled();

    await page.getByTestId("shareReceiver-input").fill(endpoints.admin_addr);
    // No vault selected yet: the gateway refuses an empty destination list, so the freeze stays closed.
    await expect(button).toBeDisabled();
    // The owner selects the vault the agent may deposit into (issue 1889); nothing is implied.
    await page.getByTestId("destination-extra").fill(endpoints.vault_addr);
    await expect(button).toBeEnabled();
    // No commit button exists before the freeze, and none is enabled before the agent consents.
    await expect(page.getByTestId("authorize-submit")).toHaveCount(0);
  });

  test("config-export panel appears after valid register inputs are supplied", async ({ page }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);
    // The owner selects the vault the agent may deposit into (issue 1889); nothing is implied.
    await page.getByTestId("destination-extra").fill(endpoints.vault_addr);
    await openTab(page, "export");

    const exportPanel = page.getByTestId("config-export");
    await expect(exportPanel).toBeVisible();
  });
});
