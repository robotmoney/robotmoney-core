# ADR-0016: BNKR is the rmAGENT test asset on Uniswap V4 while RM is parked

- **Status:** Superseded by [ADR-0017](ADR-0017-rmagent-retired-router-uses-three-vaults.md) in full: rmAGENT is retired, BNKR is dropped, and no stage deploys the V4 recorder. The due diligence below stays as the record of the contained test.
- **Date:** 2026-10-22
- **Deciders:** Product owner
- **Related:**
  - `docs/adr/ADR-0001-mvp-agent-token-shortlist.md` (BNKR is named there; the contained test scope is defined there)
  - `docs/adr/ADR-0004-agent-token-shortlist-governance.md`
  - `docs/adr/ADR-0005-basketvault-multi-dex-routing.md`
  - `docs/adr/ADR-0015-rm-parked-from-rmagent-until-market-depth.md`
  - `config/agent-token-shortlist.json`
  - `docs/code-review/20261021-code-review-internal-claude-rm-parked-from-rmagent.md`
  - core issue 1903, GitHub issue 1905 (two-hop route)

## Context

ADR-0015 parks RM out of rmAGENT. Without an asset the vault is empty, so the Uniswap V4 swap adapter and the V4 price recorder cannot be tested end to end on Base.

The owner first considered another token and then chose BNKR. Owner decision, verbatim: "Lets keep bnkr, $400 is fine for our tests".

BNKR (BankrCoin) is the live Base agent-economy token that ADR-0001 already names. Its Uniswap V4 BNKR/USDC pool (id `0x87a44b2ff90d59448342017e80c513fd469c9f5edc34db815436a5d984000f52`) is thin. DexScreener (third party, not verified on chain) shows about $462 of liquidity and about $43 of 24 hour volume. Two other tiny V4 BNKR/USDC pools exist and are ignored. The deep BNKR market (about $1.96M) is a V3 BNKR/WETH pool that the design does not use. GitHub issue 1905 tracks a two-hop route for it.

## Due diligence (measured on Base at block 52922123, cast against `mainnet.base.org`)

Token `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b`:

- Name BankrCoin, symbol BNKR, 18 decimals, total supply 1e11 tokens (1e29 raw).
- Plain ERC-20 of 4,385 bytes of runtime code. The only selectors beyond ERC-20 are `fid()`, `castHash()`, `deployer()` and `image()`: metadata getters.
- No `owner()`, no mint, no pause, no blacklist, no transfer tax or fee, no transfer restriction in the selector set. The EIP-1967 implementation slot reads zero, so it is not a proxy.
- Code hash `0x334311ad8d9f8a10d5d16d38bc215d0de7f8204d332a6f1a060ebb3f4adbc57f`, pinned in the config like USDC.

Pool: currency0 BNKR, currency1 USDC, fee 3000 (0.30%), tickSpacing 60, **hooks zero** (hookless, so the V4 adapter and recorder support it). The key hashes to the pool id above (checked by `config-check` and by a Foundry test). The PoolManager also takes a 5 bps protocol fee on this pool.

Depth: in-range liquidity L is 3.9077e16, which is 39 times the production floor `VAULT_AGENT_MIN_POOL_LIQUIDITY` of 1e15. The floor is not lowered. In dollars that is about 706 USD of virtual USDC reserve at the live price of about 3.26e-4 USDC per BNKR. Raw L maps to a different dollar depth per token, so BNKR passes the floor where RM did not (RM: L 6.5e13, about 0.11 USDC).

Price impact against the live pool (V4 quoter, USDC in):

| Buy | BNKR out | Shortfall against spot | Of which fees |
|---|---|---|---|
| 1 USDC | 3,049.4 | 0.50% | 0.35% |
| 5 USDC | 15,161.5 | 1.05% | 0.35% |
| 10 USDC | 30,111.9 | 1.75% | 0.35% |
| 100 USDC | 270,471.9 | 11.7% | 0.35% |

The vault swap bound `maxSlippageBps` stays at the vault default 300. A 5 USDC deposit uses about 105 bps. A 10 USDC deposit uses 175 bps and leaves little room for TWAP lag. A 100 USDC deposit would revert.

## Decision

1. BNKR is the only entry in `shortlist` of `config/agent-token-shortlist.json`. RM stays in `parked.entries` (ADR-0015).
2. **The largest safe deposit is 5 USDC.** The sheets set `VAULT_AGENT_PER_DEPOSIT_CAP` to 5 USDC and `VAULT_AGENT_TVL_CAP` to 20 USDC.
3. The $462 depth is accepted for **contained tests only**, inside the test scope of ADR-0001: a 1 USDC seed, low caps, pause available, no announcement. It is **not a production sizing** and not a listing approval.
4. `VAULT_AGENT_MIN_POOL_LIQUIDITY` stays 1e15. No test bound is loosened. No test is skipped to make BNKR pass. No liquidity is seeded.
5. The V4 recorder is built from the V4 entry of `shortlist`, so it records the BNKR pool.
6. The tests that exercised the RM pool run against the BNKR pool where they are generic. The RM-specific ones stay gated by `RM_PARKED` (ADR-0015).

## Risks

- A $462 pool can be moved by one trade, so the recorder TWAP can be manipulated cheaply. The 400 bps NAV deviation guard, the 5 USDC cap and the 20 USDC TVL cap bound the loss to a few dollars.
- BNKR is a live market token with an issuer outside this protocol. The contract shows no admin function today. That can change only with a new contract, which would need a new pin.
- The volume is about $43 a day. Exits can be slow or costly at size. The caps keep size small.

## Exit and upgrade path

- Remove BNKR through the Safe and the timelock (`removeAsset`, 24 hours, ADR-0004). Caps stay low until then. `redeemInKind` pays BNKR with no oracle read.
- A deeper venue replaces the pool through a new ADR and the governed `addAsset` (48 hours) and `removeAsset` path.
- The two-hop route through the deep V3 BNKR/WETH market (GitHub issue 1905) needs its own ADR, a wider tolerance and a stated spread.
- RM returns by the reactivation criteria in ADR-0015.

## Consequences

- rmAGENT deploys non-empty and paused with one V4 asset. Stage 1b (recorder) and stage 9 (agent) run as before.
- The Twin and the CI deposit 5 USDC at most into rmAGENT.
- The mainnet test is contained. Nothing here approves BNKR for production.
