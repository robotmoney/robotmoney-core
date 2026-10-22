# RM parked out of rmAGENT: the gap and the way back (core issue 1903)

Date: 2026-10-21. Decision: [ADR-0015](../adr/ADR-0015-rm-parked-from-rmagent-until-market-depth.md). Owner, verbatim: "I think we need to provisionally drop Robotmoney from the rmAgent. Comment it out, such that we can bring it back when there is sufficient volume."

Measured on Base at block 52916480: the RM/USDC V4 pool (id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391`) holds one full-range position with in-range liquidity L 6.476e13 (about 0.11 USDC and 37,223 RM). That is 15 times below `VAULT_AGENT_MIN_POOL_LIQUIDITY` (1e15). A 1 USDC buy takes 90 percent of its RM. The deep RM market (about $154,000 per DexScreener, not verified on chain) is a V4 RM/WETH pool the design does not use.

## What rmAGENT carries now

- The owner replaced the empty outcome on 2026-10-22: BNKR is the rmAGENT test asset ([ADR-0016](../adr/ADR-0016-bnkr-is-the-rmagent-test-asset-on-uniswap-v4-while-rm-is-parked.md)). RM is parked in `parked.entries`.
- `DeployAgentTokenVault` deploys the proxy, pauses deposits, adds BNKR through the V4 adapter and the recorder, sets the NAV guard and registers the vault. Stage 1b builds the recorder from the BNKR pool.
- BNKR passes the unchanged 1e15 floor (L 3.9e16). The pool is thin in dollars (about 706 USD virtual), so the caps are 5 USDC per deposit and 20 USDC TVL.
- Measured price impact against the live pool: 1 USDC 0.50% shortfall, 5 USDC 1.05%, 10 USDC 1.75%, 100 USDC 11.7% (fees are 0.35% of each).

## Findings

### 1. The pool-depth guard is in raw liquidity L, not dollars

`VAULT_AGENT_MIN_POOL_LIQUIDITY` is a floor on L. One L is a different dollar depth at every price. At the measured price (about 2.96e-6 USDC per RM), L 1e15 is only about 1.7 USDC of in-range USDC reserve. The guard cannot tell a 2 dollar pool from a 5,000 dollar pool. The guard stays at 1e15, and reactivation is decided in dollars (`config/agent-token-shortlist.json`, `parked.reactivation.criteria`).

### 2. rmAGENT has no production asset until RM, or another token, is listed

The product promise of an agent-token basket is not delivered at launch: BNKR is a test asset on a $462 pool (DexScreener, third party), accepted by the owner for contained tests only. The gap closes only when the RM criteria below hold, or a deeper venue or the two-hop route (GitHub issue 1905) is decided in its own ADR, and a timelock `addAsset` lands.

### 3. Issue 1900 and the Twin pool tests assume RM stays listed

Issue 1900 (seed the Twin pool) is superseded: the owner ruled out seeding. The tests that need RM and its pool run on a reactivated copy of the config (`scripts/ci/rm-parked-testlib.ts`, flag `RM_PARKED`). They are not skipped and no bound is lowered.

## Reactivation criteria (dollars, at one Base block)

- Depth: in-range USDC reserve at least $5,000 and at least 48 times the AGENT per-deposit cap.
- Volume: at least $1,000 on each of the last 7 days.
- Price: within 5 percent of the price implied by the RM/WETH market.
- Raw guard: 1e15 or higher stays (the dollar depth needs L of about 2.9e15).

## Reactivation steps

1. Re-measure the criteria and record them in a new review.
2. Remove BNKR through the timelock. Move `parked.entries[0]` into `shortlist`, set `parked.entries` to `[]` and `maxSlippageBps` to 500. `RM_PARKED` becomes false. Run `bun scripts/ci/config-check.ts`.
3. Start the recorder keeper and confirm 1800 s of history.
4. Schedule `addAsset(RM)` through the Safe and the timelock (ADR-0004), after deploying the swap adapter and allowing its codehash.
5. Run the verifier, the Twin and the fork RM-pool tests with `RM_PARKED` false.

## Where RM_PARKED is read

- `scripts/ci/config-check.ts` (`rmParked`, and the rules `launch-list-is-rm-only-or-rm-parked` and `rm-parked-states-reactivation`).
- `scripts/ci/rm-parked-testlib.ts` (the reactivated copy used by the config-check tests).
