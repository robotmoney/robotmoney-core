/**
 * Sign the Withdraw tab's redeem on whichever route the tab chose (QA plan D9).
 *
 * A registered vault is redeemed through `PortfolioRouter.redeemFor` with a
 * `minAssetsPerLeg` floor, and the router first needs a share approval for
 * exactly the shares (`withdraw-approve`). A vault the router cannot redeem
 * (no router configured, not in the registry) is redeemed directly with
 * `vault.redeem` and has no approval step. `withdraw-route` carries the route
 * in `data-route`.
 *
 * Canonical: clients/dapp/src/lib/routerRedeem.ts.
 */
import { expect, type Page } from "@playwright/test";

const TIMEOUT_MS = 60_000;

/** Approve the router when the route needs it, then click "Sign withdraw with wallet". */
export async function signWithdraw(page: Page): Promise<void> {
  const route = page.getByTestId("withdraw-route");
  await expect(route).toHaveAttribute("data-route", /^(router|direct)$/, { timeout: TIMEOUT_MS });
  const submit = page.getByTestId("withdraw-submit");

  if ((await route.getAttribute("data-route")) === "router") {
    const approve = page.getByTestId("withdraw-approve");
    // Ready to sign, or ready to approve: an allowance left by an earlier run
    // may already cover the shares, and then no approval is asked for.
    await expect
      .poll(
        async () =>
          (await submit.isEnabled()) ||
          ((await approve.count()) > 0 && (await approve.isEnabled())),
        { timeout: TIMEOUT_MS },
      )
      .toBe(true);
    if (!(await submit.isEnabled())) {
      await approve.click();
    }
  }

  await expect(submit).toBeEnabled({ timeout: TIMEOUT_MS });
  await submit.click();
}
