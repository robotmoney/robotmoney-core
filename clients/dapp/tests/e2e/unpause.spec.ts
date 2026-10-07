/**
 * Playwright E2E — deposit unpause flow UI invariants (issue #82).
 *
 * Runs against the smoke-test full-stack devnet. Unpause needs ADMIN_ROLE, which
 * only the timelock holds after the handover, so the dapp offers a Safe proposal
 * ("Create Safe proposal", core 1544) rather than a wallet transaction. Connects as
 * a plain EOA for the structured-preview path, and as the agent EOA for the
 * disabled-button negative path (neither is a Safe owner). The owner-signed flow
 * is covered by safe-proposal-role-grant.spec.ts.
 */
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab } from "./helpers/wallet";

// keccak256("unpauseDeposits()")[0..4]
const UNPAUSE_SELECTOR = "0x63d8882a";

let endpoints: DevnetEndpoints;
test.beforeAll(() => {
  endpoints = loadEndpoints();
});

test.describe("deposit unpause flow — UI invariants", () => {
  test("renders structured preview, signs intended calldata, no raw-calldata leak", async ({
    page,
  }) => {
    await openDapp(page, endpoints);
    await openTab(page, "pause");

    const unpauseForm = page.getByTestId("unpause-form");
    await expect(unpauseForm).toBeVisible();

    const previewFn = unpauseForm.getByTestId("tx-preview-fn");
    await expect(previewFn).toHaveText("unpauseDeposits");
    await expect(unpauseForm.getByTestId("tx-preview-effect")).toContainText("deposits resume");
    await expect(unpauseForm.locator('[data-testid="refusal-reason"]')).toHaveCount(0);

    await expect(unpauseForm.getByTestId("tx-preview-selector")).toHaveText(UNPAUSE_SELECTOR);

    const calldataElement = unpauseForm.getByTestId("tx-preview-calldata");
    const calldataText = await calldataElement.textContent();
    expect(calldataText).toBe(UNPAUSE_SELECTOR);

    const calldataDetails = unpauseForm.getByTestId("tx-preview-calldata-details");
    await expect(calldataDetails).toBeAttached();
    const isOpen = await calldataDetails.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(false);
    await expect(calldataElement).toBeHidden();
  });

  test("the unpause proposal button is disabled when the wallet is not a Safe owner", async ({
    page,
  }) => {
    // Connect as the agent EOA — it is not an owner of the Safe, so it cannot create
    // the proposal and the dapp states why.
    await openDapp(page, endpoints, { role: "agent" });
    await openTab(page, "pause");
    const unpauseBtn = page.getByTestId("unpause-submit");
    await expect(unpauseBtn).toBeDisabled();
    await expect(unpauseBtn).toHaveText("Create Safe proposal");
    await expect(page.getByTestId("unpause-safe-refusal")).toContainText(
      "not an owner of the Safe",
    );
  });
});
