# ADR-0015: Robotmoney (RM) is parked out of rmAGENT until its market is deep enough

- **Status:** Superseded in part by [ADR-0017](ADR-0017-rmagent-retired-router-uses-three-vaults.md): decisions 2 to 4 (the empty or test-asset rmAGENT, the recorder stage and the guard on a listing) no longer apply because rmAGENT is retired. Decision 1 (RM stays parked) and the reactivation criteria stand, and now live in the retired-vault note of ADR-0017.
- **Date:** 2026-10-21
- **Deciders:** Product owner
- **Related:**
  - `docs/adr/ADR-0001-mvp-agent-token-shortlist.md`
  - `docs/adr/ADR-0004-agent-token-shortlist-governance.md`
  - `docs/adr/ADR-0005-basketvault-multi-dex-routing.md`
  - `docs/adr/ADR-0008-agent-token-vault-trading-authority.md`
  - `config/agent-token-shortlist.json` (`parked`)
  - `docs/code-review/20261021-code-review-internal-claude-rm-parked-from-rmagent.md`
  - core issue 1903

## Context

ADR-0001 (amended 2026-10-08) launches rmAGENT with one asset: RM, traded on the Uniswap V4 RM/USDC 2.91% pool and priced through the permissionless `UniswapV4PriceRecorder`. The vault guards a listing with `VAULT_AGENT_MIN_POOL_LIQUIDITY` (1e15) and a swap bound of 500 bps (`maxSlippageBps`), of which the pool fee takes 291 bps.

Measured on Base at block 52916480, the pool (id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391`) holds one full-range position:

- In-range liquidity L is 6.476e13. That is about 0.11 USDC and 37,223 RM.
- The guard is 1e15. The pool is 15 times below it.
- A 1 USDC buy takes 90 percent of the RM in range.
- The deep RM market is a V4 RM/WETH pool of about $154,000 (per DexScreener, not verified on chain). The design does not use it.

**Units finding.** The guard is in raw liquidity L. L converts to a different dollar depth at every price. At the price measured here (about 2.96e-6 USDC per RM), L 1e15 is only about 1.7 USDC of in-range USDC reserve. One floor in L cannot stand for a dollar depth, so it cannot be the reactivation test.

Owner decision, verbatim: "I think we need to provisionally drop Robotmoney from the rmAgent. Comment it out, such that we can bring it back when there is sufficient volume."

## Decision

1. RM is parked. The RM entry, the reason, the measurements and the reactivation criteria live under `parked` in `config/agent-token-shortlist.json`, which no script or contract reads.
2. The `shortlist` is not empty: the owner chose BNKR as the rmAGENT test asset on 2026-10-22 ([ADR-0016](ADR-0016-bnkr-is-the-rmagent-test-asset-on-uniswap-v4-while-rm-is-parked.md)). The vault still deploys at stage 9, paused, so the four-vault topology, the registry row and the handover are unchanged. Tokens are added and removed through the Safe and the timelock (ADR-0004).
3. The V4 price recorder stage (1b) is unchanged: it builds the recorder from the V4 entry of `shortlist`. The recorder code and its tests stay.
4. `VAULT_AGENT_MIN_POOL_LIQUIDITY` is not changed. No test bound is loosened. No liquidity is seeded.
5. The tests that need RM and its pool are gated by one flag, `RM_PARKED`, true exactly while `parked.entries` is not empty. RM-pool tests run on a reactivated copy of the config where they are generic. Reactivation flips the flag by the same edit that restores the entry.

### Reactivation criteria (dollars at the live price, measured at one Base block)

- Depth: in-range USDC reserve of the RM/USDC pool is at least $5,000 and at least 48 times the AGENT per-deposit cap. (The 209 bps price-impact budget is 500 minus 291 bps, and impact is about swap size over reserve.)
- Volume: at least $1,000 of volume on each of the last 7 days.
- Price: pool price within 5 percent of the price implied by the RM/WETH market.
- Raw guard: 1e15 or higher stays. At the measured price the dollar depth needs L of about 2.9e15.

## Rejected options

- **Lower the floor.** L is not a dollar depth, so a lower floor admits a pool of cents. This is how a 90 percent loss on a 1 USDC buy would pass the guard.
- **Loosen test tolerances.** It makes the tests agree with a broken market.
- **Skip the tests.** A silent skip reads as a pass. The flag is explicit and named.
- **Seed the Twin.** It hides the real market signal and proves nothing about mainnet.
- **Widen the slippage tolerance.** The bound is 500 bps. Widening it enough to trade this pool would legalize a loss of about 90 percent per deposit.

## Options kept open for reactivation

Each needs its own ADR.

- Fund the RM/USDC pool until the criteria above hold.
- Route through the deep RM/WETH pool with a two-hop route, a wider tolerance and a stated spread.

## Consequences

- rmAGENT carries no RM. What it carries instead is decided in ADR-0016.
- Issue 1900 (seed the Twin pool) is superseded by this decision.
- Reactivation is: remove the test asset through the timelock, move the RM entry back, run the recorder keeper, and schedule a timelock `addAsset`, with the criteria re-measured first.

## Amendment — 2026-10-22 (BNKR test asset)

The first version of this ADR shipped rmAGENT empty. The owner replaced that outcome the next day: BNKR is the test asset. See [ADR-0016](ADR-0016-bnkr-is-the-rmagent-test-asset-on-uniswap-v4-while-rm-is-parked.md).
