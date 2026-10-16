/**
 * Set the browser's clock to the chain's clock (QA plan D9).
 *
 * The router redeem carries a `deadline` that the dapp builds from the browser clock at submit time
 * (`routerRedeemDeadline`), and `PortfolioRouter.redeemFor` reverts `DeadlineExpired` once the chain's
 * `block.timestamp` is past it. On Base the two clocks agree to the second. The devnet does not: its
 * boot warps chain time forward to get through the timelock delay (the Twin fork's governance step),
 * so the chain runs hours or days ahead of the runner's wall clock, and every deadline built from
 * `Date.now()` is already expired when the simulation runs. The spec that redeems through the router
 * calls this before it opens the dapp, which fixes `Date.now()` at the chain's latest block time.
 */
import type { Page } from "@playwright/test";

/** The latest block's timestamp, in seconds, read from the devnet RPC. */
export async function chainNowSecs(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  const j = (await res.json()) as { result?: { timestamp?: string } };
  if (!j.result?.timestamp) throw new Error(`chainNowSecs: no latest block from ${rpcUrl}`);
  return Number(BigInt(j.result.timestamp));
}

/** Fix the page's `Date.now()` at the chain's latest block time. Call it before `page.goto`. */
export async function syncBrowserClockToChain(page: Page, rpcUrl: string): Promise<void> {
  await page.clock.setFixedTime(new Date((await chainNowSecs(rpcUrl)) * 1000));
}
