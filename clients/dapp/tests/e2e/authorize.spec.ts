/**
 * Playwright E2E — authorize flow UI invariants.
 *
 * Runs against the smoke-test full-stack devnet booted by
 * `devnet-global-setup.ts`. Connects as the admin EOA via the
 * Playwright-injected EIP-1193 provider — the dapp uses its prod
 * `injected()` connector exactly as it would with a real wallet
 * extension.
 *
 * Asserts the human walkthrough never surfaces a raw-calldata-only
 * signing prompt: every preview section either renders the structured
 * fields OR emits an explicit refusal — there is no third path.
 *
 * The authorize flow uses a two-step commit/reveal scheme (AZ-DAPP-1):
 * the commit phase previews the commitAuthorization call it signs and the
 * revealAuthorization call (with the policy) that step 2 signs (QA plan U4).
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp } from "./helpers/wallet";

test.describe("authorize agent — UI invariants", () => {
  let endpoints: DevnetEndpoints;

  test.beforeAll(() => {
    endpoints = loadEndpoints();
  });

  test("an agent with no selected vault is refused before signing", async ({ page }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(endpoints.agent_addr);
    await page.getByTestId("shareReceiver-input").fill(endpoints.share_receiver_addr);

    // Nothing is pre-selected and the gateway reverts an empty list, so the dapp builds no
    // preview and keeps the commit button disabled.
    await expect(page.getByTestId("destinations-empty")).toBeVisible();
    await expect(page.getByTestId("authorize-submit")).toBeDisabled();
    await expect(page.locator('[data-testid="tx-preview"][data-ok="true"]')).toHaveCount(0);

    // Selecting the vault opens the commit.
    await page.getByTestId("destination-extra").fill(endpoints.vault_addr);
    await expect(page.getByTestId("destinations-empty")).toHaveCount(0);
    await expect(page.getByTestId("authorize-next-reveal-preview")).toContainText(
      "allowedDestinations",
    );
  });

  test("structured preview renders for authorize, not raw calldata", async ({ page }) => {
    await openDapp(page, endpoints);

    await page.getByTestId("agent-input").fill(endpoints.agent_addr);
    // The share receiver is always the signing wallet (ACL-9): the admin EOA here.
    await page.getByTestId("shareReceiver-input").fill(endpoints.admin_addr);
    // The owner selects the vault the agent may deposit into (issue 1889); nothing is implied.
    await page.getByTestId("destination-extra").fill(endpoints.vault_addr);
    // The previews come from the frozen inputs.
    await page.getByTestId("authorize-freeze").click();

    const previews = page.locator('[data-testid="tx-preview"][data-ok="true"]');
    await expect(previews.first()).toBeVisible();

    // The depositor signs commitAuthorization then revealAuthorization, so those are
    // the previews (QA plan U4): never authorizeAgent, which this wallet does not sign.
    const commitPreview = page.getByTestId("authorize-commit-preview");
    await expect(commitPreview.getByTestId("tx-preview-fn")).toHaveText("commitAuthorization");
    // Consent comes first: the owner commit is disabled until the agent's consent is on chain.
    await expect(page.getByTestId("authorize-submit")).toBeDisabled();
    const revealPreview = page.getByTestId("authorize-reveal-preview");
    await expect(revealPreview.getByTestId("tx-preview-fn")).toHaveText("revealAuthorization");
    await expect(revealPreview.getByTestId("tx-preview-effect")).toContainText("AGENT_ROLE");

    // Acceptance criterion: no raw-calldata-only signing surface.
    const refusalCount = await page.locator('[data-testid="refusal-reason"]').count();
    expect(refusalCount).toBe(0);
  });
});
