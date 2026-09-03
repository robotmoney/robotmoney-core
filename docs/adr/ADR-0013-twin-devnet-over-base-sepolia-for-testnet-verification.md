# ADR-0013: Verify deploy tooling and dapp integration against the Robot Money Devnet ("Twin"), not public Base Sepolia

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Product owner
- **Related:**
  - `docs/technical/full-stack-devnet.md` — the Robot Money Devnet ("Twin")
    this ADR designates as the primary verification target.
  - `docs/operations/base-sepolia-deployment.md` — the Base Sepolia
    rehearsal runbook this ADR downgrades to a secondary, opt-in rehearsal.
  - `docs/future/review-usdc-seed.md` — unrelated temporary change made
    while investigating this decision (`SEED_DEPOSIT_AMOUNT` lowered to
    unblock testnet faucet limits); not reverted by this ADR.
  - `contracts/script/Deploy.s.sol` (`AAVE_V3_POOL`, `COMPOUND_V3_COMET`,
    `MORPHO_GAUNTLET_USDC_PRIME` constants) — the pinned Base-mainnet
    protocol addresses whose Base Sepolia gap this ADR documents.
  - PR #1340 (superseded) — the original attempt at a live Base Sepolia
    deploy, which surfaced the finding below.

## Context

Issue #1303's Base Sepolia rehearsal (`docs/operations/base-sepolia-deployment.md`)
was written on the assumption that adapters would *register* successfully
against Base Sepolia even though their yield legs wouldn't resolve against a
live pool ("the live Base Sepolia run currently exercises the core ceremony
and the adapter registration, not live pool yield. Tracked separately.").

A first live attempt against real Base Sepolia (chain id `84532`) showed this
assumption doesn't hold. `RobotMoneyVault.totalAssets()` sums
`adapter.totalAssets()` across every *registered* adapter — including during
the deploy script's mandatory seed deposit — so a registered adapter whose
pinned pool address has no bytecode on the target chain reverts the ceremony
outright, not just later yield queries. `Deploy.s.sol` hardcodes all three
adapters to **Base-mainnet** protocol addresses:

| Adapter | Constant | Base Sepolia (84532) |
| --- | --- | --- |
| Aave V3 | `AAVE_V3_POOL` | **Real deployment exists** at `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` (confirmed via `cast code` and the official `bgd-labs/aave-address-book`). |
| Compound V3 (Comet) | `COMPOUND_V3_COMET` | **No deployment exists.** The official `compound-finance/comet` repo's `deployments/` directory has no `base-sepolia` (or any Base testnet) subdirectory at all. |
| Morpho | `MORPHO_GAUNTLET_USDC_PRIME` | **Core-only.** Morpho Blue's core contract, `AdaptiveCurveIrm`, and an oracle factory are deployed (per `docs.morpho.org/addresses`), but no USDC-specific market or MetaMorpho/Vault-V2 vault exists — nothing a production-shaped adapter can point at. |

This was independently re-verified twice: once via web research against each
protocol's official docs/registries, and once via direct `cast code` calls
against Base Sepolia for the specific addresses involved.

The consequence: Base Sepolia cannot host a production-parity three-adapter
vault. Any adapter-registering ceremony there either (a) omits Compound V3
and Morpho, which no longer proves what the runbook claims to prove, or (b)
requires forking Deploy.s.sol's adapter wiring into a testnet-specific branch
that diverges from the real deploy path — the opposite of what a rehearsal is
for.

The repository already has an environment built to avoid exactly this
problem: the **Robot Money Devnet** (`docs/technical/full-stack-devnet.md`,
internally referred to as the "Twin"). Its Geth genesis is seeded from a
pinned Base-mainnet state snapshot, so real Aave, Compound, Morpho, and USDC
contracts exist at their canonical addresses from block 0 — the exact
addresses `Deploy.s.sol` already hardcodes. No adapter address overrides, no
testnet-specific deploy-script branch, and no loss of ceremony fidelity.

## Decision

**The Robot Money Devnet is the default target for verifying deploy tooling,
the deploy runbook, and dapp integration.** Base Sepolia rehearsal
(`docs/operations/base-sepolia-deployment.md`) remains available for what it
is still uniquely good for — proving real network conditions (gas, nonces, a
chain nobody can restart) — but is no longer the default or recommended path
for a full three-adapter ceremony, and its docs must carry this gap rather
than imply full adapter parity.

Concretely:

1. Deploy-tooling and dapp-integration verification work defaults to
   `cargo run -p smoke-test` / the docker-compose devnet stack, not a live
   Base Sepolia deploy.
2. `docs/operations/base-sepolia-deployment.md`'s "Adapter address honesty"
   section is corrected: registering Compound V3 or Morpho against their
   Base-mainnet-pinned addresses on Base Sepolia reverts the ceremony (not
   merely "yield doesn't resolve"). A rehearsal that needs to complete the
   full ceremony on Base Sepolia must explicitly skip those two adapters or
   supply Sepolia-specific overrides; this ADR does not build that path,
   since the Devnet already covers the same ground with full fidelity.
3. No change to `Deploy.s.sol`'s production adapter wiring — the constants
   stay pinned to Base mainnet, which is correct for the contracts' actual
   deploy target.

## Consequences

- Deploy-tooling and dapp-integration verification gets full production
  parity (real Aave/Compound/Morpho state) essentially for free, since the
  Devnet already exists for this purpose.
- The Devnet is local-only (docker compose on a developer or CI machine), so
  it does not exercise real network conditions (public RPC latency, real gas
  markets, a chain that persists across restarts) the way Base Sepolia does.
  Where that matters specifically — e.g. re-proving deploy-script gas/nonce
  behavior — Base Sepolia rehearsal remains the tool for the job, with the
  adapter gap above understood going in.
- `docs/operations/base-sepolia-deployment.md` has been corrected (its
  "Adapter address honesty" section and a top-of-doc pointer to this ADR) so
  it no longer implies the three-adapter ceremony completes cleanly on live
  Base Sepolia.
