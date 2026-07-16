# ADR-0010: Unified Vault architecture — one Vault class, position adapters for every theme

- **Status:** Proposed
- **Date:** 2026-07-16
- **Deciders:** Product owner
- **Related:**
  - `docs/technical/unified-vault-spec.md` (companion engineering spec — the
    normative detail for everything summarized here)
  - `contracts/RobotMoneyVault.sol` — adapter registry, `totalAssets`,
    `_routeDeposit`, `_pullProportional`
  - `contracts/vaults/BasketVault.sol` — realized-delta `_deposit`
    (AZ-BSK-1/-3), `RedeemOnly`, `_lastMintedShares`/`_lastWithdrawnAssets`,
    ORA-4 NAV-deviation guard
  - `contracts/interfaces/IStrategyAdapter.sol`,
    `contracts/interfaces/IBasketSwapAdapter.sol`
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` (superseded in part —
    see Decision §6)
  - `docs/adr/ADR-0005-basketvault-multi-dex-routing.md` (venue seam retained)
  - `docs/adr/ADR-0006-despxa-rwa-vault-design.md` (rmRWA constraints retained)
  - `docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md` (migration
    model applied to v1 → v2)

## Context

The protocol today ships two structurally different vault families:

1. **`RobotMoneyVault`** (rmUSDC) — an ERC-4626 vault that owns no positions
   directly. It routes USDC through a registry of `IStrategyAdapter` lending
   adapters (Morpho/Aave/Compound), each with an instance allowlist, codehash
   pinning, a per-adapter `capBps`, ADP-2 NAV exclusion for revoked adapters,
   proportional withdrawal pulls (`InsufficientAdapterLiquidity`), and the
   FEE-2 realized-proceeds fee rule.

2. **`BasketVault` and its subclasses** (`ProtocolAssetVault` → rmPROTO,
   `AgentTokenVault` → rmAGENT, `RwaVault` → rmRWA) — vaults that custody
   basket tokens directly, execute swaps through the `IBasketSwapAdapter`
   venue seam (ADR-0005), price via TWAP or Chronicle oracle (ADR-0006), mint
   on the realized NAV delta (AZ-BSK-1/-3), operate redeem-only
   (`RedeemOnly`, `_lastWithdrawnAssets`), and enforce the ORA-4
   NAV-deviation guard and per-asset emergency-unwind guards.

The families duplicate lifecycle machinery (pause, shutdown, retirement, fee
accounting, TVL caps) while diverging on accounting semantics, and hardening
applied to one family (e.g. FEE-2, ADP-2) does not automatically protect the
other. `BasketVault` also concentrates swap execution, TWAP/oracle pricing,
and per-asset guards inside the vault itself, keeping it under EIP-170
pressure and forcing every new theme to be a new subclass with its own audit
surface.

The observation motivating this ADR: **a basket asset held via a swap venue
is just another yield-bearing position** — deposit USDC in, report a
USDC-denominated value, return USDC out. The only real semantic difference
from a lending position is that the conversion is inexact (slippage) rather
than 1:1.

## Decision

**Unify the two families into a single `Vault` contract whose only position
mechanism is a registry of `IPositionAdapter` contracts. All vault themes
become isomorphic deployments of that one class, differing only in their
adapter set and parameters.**

### 1. Direction of unification

`RobotMoneyVault`'s adapter architecture is the general case. Unification
means making basket assets look like strategy adapters — **not** making
`RobotMoneyVault` a `BasketVault` subclass. The vault stays a pure
USDC-in/USDC-out allocator; everything asset-specific moves behind the
adapter boundary.

### 2. `IPositionAdapter` — superset of `IStrategyAdapter`

- `deploy(uint256 usdcIn, uint256 minValueOut) returns (uint256 valueAdded)`
- `withdraw(uint256 usdcWanted, uint256 minUsdcOut) returns (uint256 usdcOut)`
- `totalAssets() view returns (uint256)` — USDC-denominated self-pricing
- `isExact() view returns (bool)` — `true` for lending adapters, `false` for
  swap-based adapters
- `harvestRewards()`, `sweepForeignToken(address)` — unchanged from
  `IStrategyAdapter`

### 3. Lending adapters retrofit trivially

Morpho/Aave/Compound adapters return `isExact() == true`; the min-out
parameters are trivially satisfied because the USDC conversion is 1:1.

### 4. Basket assets become `AssetPositionAdapter`s

Each basket asset becomes one adapter owning: token custody, swap execution
via the existing `IBasketSwapAdapter` venue seam (Uniswap V3/V4, Aerodrome —
ADR-0005 unchanged), pricing (TWAP window config, or Chronicle oracle +
heartbeat for deSPXA per ADR-0006), the per-asset emergency-unwind guard, and
the NAV-deviation check (ORA-4). These all move **out of the vault** into the
adapter.

### 5. Unified vault semantics

- **NAV:** `totalAssets() = idle USDC + Σ eligible adapter.totalAssets()`.
- **Deposit:** route USDC into adapters **first**, then mint on the realized
  NAV delta, with a slippage-floor revert guard — `BasketVault`'s
  AZ-BSK-1/AZ-BSK-3 model, which degenerates to exact behavior for lending
  adapters (realized delta == deposit).
- **Withdrawal:** `withdraw()`/`previewWithdraw()` are permitted iff **every**
  active adapter reports `isExact()`; otherwise they revert `RedeemOnly` and
  `redeem()` returns realized proceeds (the `_lastWithdrawnAssets` pattern).
- **Pulls and fees:** proportional pull with `InsufficientAdapterLiquidity`
  and the FEE-2 realized-proceeds fee rule carry over from
  `RobotMoneyVault` unchanged.

### 6. Governance and lifecycle carry over uniformly

`adapterAllowed` instance allowlist + `adapterCodeHashAllowed` codehash
pinning, per-adapter `capBps`, ADP-2 NAV exclusion of revoked adapters,
keeper rebalance throttles, registry `retire()`/`unretire()`, split pause,
and shutdown/restore apply identically to every theme. In particular, basket
themes gain `rebalance()` for free through the shared allocator — **this
supersedes the ADR-0003 `NotImplemented()` rebalance stub**; the
new-deposits-only restriction of ADR-0003 no longer applies once a theme is
deployed on the unified Vault.

### 7. Themes are deployments, not subclasses

- **rmUSDC** = lending adapters, `maxSlippage` 0.
- **rmPROTO** = wETH/cbBTC/wSOL Uniswap V3 adapters.
- **rmAGENT** = shortlist token adapters per
  `config/agent-token-shortlist.json` (V3/V4/Aerodrome).
- **rmRWA** = a single deSPXA Chronicle-priced Aerodrome adapter
  (`maxAssets = 1` becomes an adapter-count cap parameter).

### 8. Migration: fresh v2 deployment, ADR-0009 retirement of v1

v1 contracts are immutable and untouched. v2 is a fresh deployment:
register in `VaultRegistry`, shift `PortfolioRouter` weights, then
governance `retire()` on each v1 vault per ADR-0009 — withdrawals stay open
on v1 indefinitely and there is no assisted migration.

## Alternatives considered

- **Make `RobotMoneyVault` a `BasketVault` subclass (invert the direction)** —
  rejected: bakes swap/TWAP/oracle machinery into the base class every theme
  inherits, keeps EIP-170 pressure in the vault, and turns the clean
  USDC-allocator into the special case.
- **Keep two families and backport hardening piecemeal** — rejected: every
  fix (FEE-2, ADP-2, AZ-BSK-*) must be applied and audited twice, and the
  families continue to drift; this is the status quo the ADR exists to end.
- **Upgrade v1 in place** — not available: v1 contracts are immutable by
  design; any unification is necessarily a fresh deployment.

## Consequences

**Positive.**

- One class, one audit surface, one accounting model. Hardening added to the
  Vault or the adapter contract protects every theme at once; the FEE-2 and
  ADP-2 protections now cover basket themes too.
- New themes are configuration (an adapter set + parameters), not new
  Solidity subclasses.
- EIP-170 pressure disappears from the vault: swap execution, TWAP/oracle
  pricing, and per-asset guards live in adapters.
- Basket themes gain keeper `rebalance()` uniformly (supersedes the ADR-0003
  stub).
- ERC-4626 behavior is uniform and predicate-driven: exact mode when all
  adapters are exact, redeem-only otherwise.

**Negative / accepted risks.**

- **The adapter trust boundary widens.** Adapters now both custody assets and
  self-price them (`totalAssets()`), so a malicious or buggy adapter can
  misstate NAV. Mitigations: codehash pinning, ADP-2 NAV exclusion on
  revocation, and FEE-2 realized-proceeds checks — all of which now also
  protect basket themes.
- One extra external call per asset per deposit/redeem (gas overhead versus
  in-vault swaps).
- A full re-audit of the Vault plus the adapter set is required; v1 audit
  results do not transfer wholesale.
- ERC-4626 conformance must be re-verified per composition — exact mode
  versus redeem-only mode behave differently and both must be exercised.

**Out of scope of this decision.**

- The engineering detail — interface signatures beyond §2, storage layout,
  rounding, guard thresholds, deployment scripts — lives in
  `docs/technical/unified-vault-spec.md`.
- v1 retirement mechanics and depositor communication — governed by ADR-0009.
- Venue adapter mechanics (`IBasketSwapAdapter`) — governed by ADR-0005,
  unchanged; the seam is consumed by `AssetPositionAdapter`s instead of the
  vault.
- deSPXA asset constraints (KYC, freeze risk, Chronicle heartbeat) — governed
  by ADR-0006, unchanged.
