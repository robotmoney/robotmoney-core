# ADR-0018: rmHARD, a Hard Assets basket holding PAXG on its Aero pool, is the fourth router vault in the retired rmAGENT slot

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Product owner
- **Supersedes in part:** [ADR-0017](ADR-0017-rmagent-retired-router-uses-three-vaults.md) decision 1 ("the router routes across exactly three vaults") and its Receipts section (the `agent_tokens` bucket maps to no vault). ADR-0017 decisions 2 to 8 and its retired-vault note stay: rmAGENT stays withdraw-only under [ADR-0009](ADR-0009-vault-retirement-no-assisted-migration.md).
- **Related:**
  - [ADR-0002](ADR-0002-router-default-weights-on-chain.md) (amended: the four-leg launch vector)
  - [ADR-0005](ADR-0005-basketvault-multi-dex-routing.md) (the per-asset venue abstraction and the `AerodromeSwapAdapter` this vault uses)
  - [ADR-0006](ADR-0006-despxa-rwa-vault-design.md) (the 2026-10-02 move of rmRWA to a Uniswap V3 pool, which this vault departs from on the venue only)
  - [ADR-0014](ADR-0014-governed-uups-upgrades-and-freeze.md) (the new proxy joins the governed set)
  - `docs/prd.md` §11.5, `config/hard-assets.json`, `contracts/vaults/HardAssetsVault.sol`, `contracts/script/DeployHardAssetsVault.s.sol`
  - core issue 2008, GitHub issue 1905 (multi-hop swaps, not a dependency)

## Context

ADR-0017 retired rmAGENT and left the router with three vaults: rmUSDC, rmPROTO and rmRWA. The Investment Committee receipt still carries a fourth bucket, `agent_tokens`, that mapped to no vault at 0 bps. None of the three vaults offers a hard-asset exposure.

Owner request (2026-11-07, verbatim): "Restore a fourth vault for gold, using XAUT, called a 'Hard Assets' vault, with the same rules as the other vaults, as the replacement for the rmAGENT vault we sunset."

XAUT is not on Base. The XAUt0 deployment index (Everdawn Labs, `usdt0-audit-reports`) lists 14 chains and not Base. The Ethereum XAUt0 adapter `0xb9c2321BB7D0Db468f570D10A424d1Cc8EFd696C` returns `peers(30184)` (Base) = 0 at Ethereum block 26360486, and the Arbitrum XAUt0 OFT returns the same. The Base tokens named "Tether Gold" are look-alikes with round supplies and wrong decimals. Evidence: issue 2008 comments of 2026-11-07 and 2026-11-09.

Owner decision (2026-11-09): find another issuer-backed gold token on Base. The candidates, measured at Base block ~55.3M:

| Token | Issuer lists the Base address | Deepest USDC venue | Outcome |
| --- | --- | --- | --- |
| PAXG `0xe904AEA5E1b110c9174728fA2efFc8aeD19E98Ef` | Yes, docs.paxos.com (Base Mainnet) | Aero CL pool `0x108c5c97155D35847c61683F1a254D9c0470A591`, about 386k USDC and 127 PAXG | Chosen |
| DGLD `0xe908475f8Beb7A138B0dc6eb5A05cb27068ffB9A` | Yes, dgld.ch | Uniswap V3 about $680; a deeper V4 pool is likely hooked | Rejected: no usable hookless pool, and the issuer can switch on a transfer fee |
| VNXAU `0xAc3FE22294beaED9d1FD752323a6d06D12Ff3098` | VNX announcement | Aerodrome about $100k, no Uniswap USDC pool | Rejected on depth |
| XAUm, KAU, XAUt0 | Not on Base | none | Rejected |

PAXG has no Uniswap V3 pool on Base (factory `getPool` returns zero at every fee tier) and no Uniswap V4 PAXG/USDC pool with liquidity. Its market is the Aero pool. Aero is the merged Aerodrome and Velodrome DEX (launched 2026-10-21); its Slipstream CL factory on Base is `0x9CB220581b91b0C83223012FE69688b92aD07a76` and its swap router is `0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418` (dromos-labs `metadex-slipstream-public`, `deployment-addresses/cl-base.json`).

Owner decision (2026-11-10): use PAXG, priced and traded through its Aerodrome USDC pool. The scope includes the Aerodrome deploy wiring and a fork proof of the existing adapter against that pool's factory.

## Decision

1. **The router routes across four vaults: rmUSDC, rmPROTO, rmRWA and rmHARD.** The launch vector is rmUSDC 9500, rmPROTO 500, rmRWA 0, rmHARD 0 (sum 10000). The sheets carry `ELIGIBLE_VAULTS=PROTO,RWA,HARD` and `ROUTER_WEIGHTS=USDC:9500,PROTO:500,RWA:0,HARD:0`. `PortfolioRouter` needs no change: the vector length follows `registry.routerEligibleCount()`.
2. **rmHARD is a new vault, not the retired rmAGENT.** `HardAssetsVault` is a thin `BasketVault` subclass ("Robot Money Hard Assets", symbol `rmHARD`, at most 10 assets, 100 bps default slippage), the same shape as `RwaBasketVault`. Its proxy joins the governed set (ADR-0014) with its own storage-layout pin. rmAGENT is not reopened, reactivated or migrated.
3. **One asset at launch: PAXG.** More hard assets are later `addAsset` calls through the timelock, as for rmPROTO and rmRWA.
4. **Venue: the PAXG Aero CL USDC pool, through the existing `AerodromeSwapAdapter`.** The config row is venue `Aerodrome`, pool `0x108c…A591`, `poolFee` 10 (the pool's tick spacing, the value the vault forwards and checks under ORA-3). `BasketVaultDeployBase` gains an Aerodrome branch: it deploys one `AerodromeSwapAdapter(router, factory)` from the config root keys `aerodromeSlipstreamRouter` and `aerodromeSlipstreamFactory`, allows its code hash and calls `addAsset` with `Venue.Aerodrome`. Before any state change it checks that the pool has code, reports the config tick spacing, is the factory's canonical pool for PAXG/USDC at that spacing, names that factory, holds at least `MIN_POOL_LIQUIDITY`, and charges a live fee below the NAV guard. A config never mixes Aerodrome and Uniswap V3 rows, because `Deployed.adapter` names one external adapter. No guard is weakened: `addAsset` still enforces the token/USDC pair, the window-derived cardinality floor and the observation history of the asset's TWAP window (decision 6).
5. **The adapter is proven against the Aero factory.** The adapter takes its factory and router as constructor arguments and checks `FACTORY.getPool(base, quote, tickSpacing) == pool` on every price read. The Aero router's `exactInputSingle` struct is identical to the Slipstream one the adapter calls. `contracts/test/HardAssetsVaultFork.t.sol` runs the real deploy script against the real pool, factory and router on the fork pin, with the pool exactly as it is: `addAsset` passes, it prices 1 PAXG over the PAXG window, deposits USDC, holds PAXG, and redeems in one transaction within the slippage cap of `previewRedeem`.
6. **TWAP window: 1798 s for PAXG, chosen to fit the pool's real observation ring.** The PAXG Aero pool's ring holds 900 slots. `BasketAssetConfigGuard` requires `window / 2 s + 1` slots, so the vault default of 1800 s would need 901 and `addAsset` would refuse the pool. The vault fits the pool as it exists; it never changes third-party pool state (owner correction 2026-11-10: no `increaseObservationCardinalityNext` call, now or as a deploy prerequisite, and no Twin-only storage stand-in). 1798 s is the longest window a 900-slot ring covers in the worst case of one observation per 2 s block (1798 / 2 + 1 = 900). It is 2 s shorter than the default, inside `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`, so the manipulation resistance of the TWAP is unchanged in practice. The window is a config row field (`twapWindow: 1798`). The deploy registers PAXG through `HardAssetsVault.addAssetWithTwapWindow`, an ADMIN_ROLE entry point that bounds the window like `setTwapWindow`, sets it, and runs the same `BasketAssetConfigGuard.addAsset` as `BasketVault.addAsset` for that window, in one call. `BasketVault` is not changed: rmPROTO, rmRWA and the retired rmAGENT keep their bytecode, logic-identical to Deploy 3 (issue 1914), and the 901-slot floor at 1800 s; the inherited `addAsset` keeps that floor on rmHARD too. The guard itself is unchanged (`requireObservationHistory`: the window-derived floor and `observe([window, 0])`), and `MIN_TWAP_WINDOW` is not lowered. NAV, slippage floors and the dust check read the same window (`effectiveTwapWindow`). No oracle is added. No storage is added, and the layout pins are unchanged.
7. **Nothing changes the pool's state.** No deploy step, test, Twin fork or runbook step raises the pool's ring or swaps in it to make a check pass. The fork test runs against the pool as it is at the pin. `config-check` checks the live pool against the asset's window floor (900) and `observe([1798, 0])`. If the pool's history ever stopped reaching 1798 s, the guard and the check fail closed, and the window is changed through the timelock with `setTwapWindow`, which vets the live pool.
8. **18 decimals.** PAXG has 18 decimals, as deSPXA does. The TWAP price path works in raw units from the tick (`TwapTickMath.priceFromTick`), so no decimals input exists or is needed. `tokenDecimals: 18` in the config is read by the config check only. The vault's 18-decimal virtual share offset is unchanged.
9. **Risk label VOLATILE.** Gold moves against USDC, like rmPROTO's assets. The explorer indexer classifies a registration name containing "hard asset" as VOLATILE.
10. **Issuer freeze-control risk (Paxos).** The PAXG proxy on Base exposes `freeze`, `freezeBatch`, `wipeFrozenAddress`, `pause` and `decreaseSupplyFromAddress` to Paxos. A freeze of the vault, or a pause of PAXG, makes every swap revert: deposits and redeems that sell PAXG fail until Paxos lifts it. `redeemInKind` pays PAXG and is also blocked by a freeze of the vault. `pauseDeposits()` surfaces the state to new depositors and never blocks a redeem. The vault never calls an issuer redemption path. The dapp vault detail page shows a Paxos freeze-control disclosure on rmHARD. The Base PAXG implementation has no transfer-fee function, so a fee-on-transfer change would need a Paxos upgrade of its proxy.
11. **Aero dynamic fees.** Aero CL pools charge a fee through a dynamic swap-fee hook (`0xC0ed888AfE87ed1AcF01D9f19bB850159e3ce434`). `fee()` read 500 pips (5 bps) at the evidence block. The deploy checks the live fee against the NAV guard. A higher dynamic fee at swap time makes the TWAP-anchored slippage floor revert the swap rather than overpay.
12. **The receipt's `agent_tokens` bucket maps to rmHARD.** The receipt schema stays 1.0 and the bucket key keeps its legacy name. `apply-receipt` maps it to the `HARD` vault key and accepts nonzero weight. The dapp maps it to `rmHARD`, falls back to `rmAGENT` on the live v0.5.0 line, and treats it as routed 0 bps on a three-vault deployment. The shared fixture `tests/fixtures/consensus-receipt.bucket-vault-map.json` is vendored from robotmoney-frontend and is not hand-edited here: it still labels the bucket rmAGENT until the frontend regenerates it (cross-repo follow-up).
13. **Deployment.** The vault deploys paused in its own stage (`hard`, after `rwa`), registers, and flips router-eligible from the sheet vector. Stage 13 unpauses it through the Safe and the timelock with the other three (`unpause-HARD`). The deployment record (`schemas/fusion-stage-record.schema.json`) requires the rmHARD address.

## Why Aerodrome, when ADR-0006 moved rmRWA to Uniswap

ADR-0006 was superseded in part on 2026-10-02 (core 1492): rmRWA left a custom Aerodrome-only path with a Chronicle oracle for a plain basket row on the deSPXA Uniswap V3 fee 500 pool. That move removed the oracle and the custom vault. It chose Uniswap because deSPXA's usable pool was on Uniswap V3 and the deploy wiring then was V3 only. It did not rule Aerodrome out as a venue: ADR-0005 keeps the venue abstraction, and rmRWA's phase-two B20 rows (core 1500) trade on Aerodrome Slipstream through the same `AerodromeSwapAdapter`.

rmHARD keeps everything the 2026-10-02 move kept: a plain basket row, pool TWAP pricing, no oracle, no custom adapter. It differs only in the pool, because PAXG's only deep USDC market is the Aero CL pool. A Uniswap row for PAXG would sit on an empty pool, fail the liquidity floor and price NAV from no trades.

## Assumptions (coordinator defaults, reversible before the mainnet deploy)

- Name "Robot Money Hard Assets", symbol rmHARD.
- One asset (PAXG) in a `BasketVault` subclass, more added through the timelock.
- Risk label VOLATILE.
- Exit fee, TVL cap, per-deposit cap, NAV guard (100 bps) and pool liquidity floor (1e12) follow the rmRWA sheet pattern.
- The `agent_tokens` bucket key is kept and pointed at rmHARD, with no receipt schema version bump.
- Router default weight 0 bps, deployed paused, unpaused in stage 13.

## Out of scope and follow-ups

- **The live Base 8453 deployment.** Adding rmHARD to the existing deployment (deploy the vault, register it, move router eligibility and the vector through the Safe and the timelock) is an owner-gated release step, not part of this change.
- **The shared receipt fixture.** robotmoney-frontend regenerates `consensus-receipt.bucket-vault-map.json` with `agent_tokens` labelled rmHARD, and core re-vendors it.
- **Multi-hop swaps** (issue 1905) are not needed: the PAXG pool pairs with USDC.

## Rejected options

- **XAUT or XAUt0.** Not deployed on Base, and no LayerZero route to Base exists.
- **DGLD on Uniswap V4.** The deep pool is likely hooked, which the V4 venue refuses. The issuer can switch on transfer and custody fees, which would break share accounting.
- **VNXAU.** No Uniswap USDC pool and about $100k on Aerodrome.
- **A price oracle for PAXG.** Every basket prices from its pool TWAP. An oracle class is a separate decision.
- **Reusing the retired rmAGENT contract.** ADR-0009 keeps it withdraw-only. Its asset family, V4 recorder and layout do not fit a gold row.

## Consequences

- A new deployment has four vaults, one more stage (`hard`) and one more governed proxy. The frozen counts of a new release gain the `hard` count.
- The deploy base supports three venues: Uniswap V3, Uniswap V4 and Aerodrome.
- The text and guards that said "three vaults" say four, and `.github/scripts/check_four_vault_references.py` replaces the three-vault drift check.
