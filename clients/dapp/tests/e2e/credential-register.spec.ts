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
import type { Address, Hex } from "viem";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";
import { fillAgentConsent } from "./helpers/depositor";

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
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    const preview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(preview).toBeVisible();

    // QA plan U4: the previews name the calls the wallet signs.
    const commitPreview = page.getByTestId("authorize-commit-preview");
    await expect(commitPreview.getByTestId("tx-preview-fn")).toHaveText("commitAuthorization");
    const revealPreview = page.getByTestId("authorize-next-reveal-preview");
    await expect(revealPreview.getByTestId("tx-preview-fn")).toHaveText("revealAuthorization");
    await expect(revealPreview.getByTestId("tx-preview-effect")).toContainText("AGENT_ROLE");

    const refusals = await page.locator('[data-testid="refusal-reason"]').count();
    expect(refusals).toBe(0);
  });

  test("authorize signing button is disabled until structured preview is valid", async ({
    page,
  }) => {
    await openDapp(page, endpoints);

    const button = page.getByTestId("authorize-submit");
    await expect(button).toBeDisabled();

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await expect(button).toBeDisabled();

    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);
    // The agent is not this wallet: no commit before the agent consents (issue 1791).
    await expect(button).toBeDisabled();
    await expect(page.getByTestId("authorize-agent-consent-command")).toContainText(
      "rmpc agent-consent",
    );

    // The agent signs AgentConsent for the connected wallet (openDapp's default admin key).
    await fillAgentConsent(
      page,
      endpoints,
      "authorize",
      { privateKey: endpoints.agent_private_key as Hex, address: AGENT_ADDRESS as Address },
      endpoints.admin_addr as Address,
    );
    await expect(button).toBeEnabled();
  });

  test("config-export panel appears after valid register inputs are supplied", async ({ page }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);
    await openTab(page, "export");

    const exportPanel = page.getByTestId("config-export");
    await expect(exportPanel).toBeVisible();
  });
});
