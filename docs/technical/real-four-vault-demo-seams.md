# Real Four-Vault Demo — Seam Map

**Scout issue:** #541
**Date:** 2026-06-02
**Canonical docs:** `docs/implementation-plan.md`, `docs/prd.md` §11, `docs/technical/basket-vault-gap-report.md`
**Phase:** Real four-vault demo (Plan #109, issues #541–#568)

---

## Purpose

This document maps the shared/hot files, per-phase serialization order,
integration seams, and the archive-RPC dependency for the Real four-vault
demo initiative. The initiative makes all four PRD §11 vaults hold real
Base-mainnet assets with real depositors at startup — no placeholder tokens,
no stub pools.

No contract, Rust, dapp, or testing source code is changed by this scout.

---

## 1. Initiative overview

The Real four-vault demo builds across eight sub-phases (A–H) on top of the
already-shipped vault registry, Portfolio Router, governance MVP, and demo
seeding harness. The four target vaults are:

| Vault | Contract | PRD §11 | Router status |
|---|---|---|---|
| Stable Yield (rmUSY) | `RobotMoneyVault` | §11.1 | Router-eligible (shipped) |
| Protocol Asset (rmPROTO) | `ProtocolAssetVault` | §11.2 | Prototype — eligibility ADRs pending |
| Agent Tokens (rmAGENT) | `AgentTokenVault` | §11.3 | Prototype — eligibility ADRs pending |
| RWA/Thematic (deSPXA) | `RobotMoneyVault` subclass or new vault | §11.4 | ADR pending; Aerodrome-only enter/exit |

---

## 2. Shared hot files by phase

### Phase A — ADRs and PRD re-spec (issues #542–#548)

All doc-only issues; no shared source files. Each ADR lives in `docs/adr/`.
They are parallel-safe with each other because no two ADRs edit the same file.

| Issue | Hot file(s) |
|---|---|
| #542 — PRD §11 re-spec | `docs/prd.md` |
| #543 — ADR-0001 agent shortlist revision | `docs/adr/ADR-0001-mvp-agent-token-shortlist.md`, `config/agent-token-shortlist.json` |
| #544 — Slippage-adjusted preview ADR | new `docs/adr/ADR-XXXX-basket-vault-slippage-preview.md` |
| #545 — Rebalancing model ADR | new `docs/adr/ADR-XXXX-basket-vault-rebalancing.md` |
| #546 — Shortlist governance ADR | new `docs/adr/ADR-XXXX-agent-token-shortlist-governance.md` |
| #547 — Multi-DEX routing ADR | new `docs/adr/ADR-XXXX-basket-vault-multi-dex.md` |
| #548 — deSPXA RWA vault ADR | new `docs/adr/ADR-XXXX-despxa-rwa-vault.md` |

### Phase B — BasketVault contract hardening (issues #549–#553)

All five issues touch `contracts/vaults/BasketVault.sol`. They must be
serialised or rebased carefully.

**Serialization order:**

1. **#549** — slippage-adjusted `previewRedeem`/`previewDeposit` (adds new
   view functions; no existing function signature change; parallel-safe with
   #550 and #551 if each targets distinct functions).
2. **#550** — TWAP-based `totalAssets` cap enforcement (modifies `_deposit`;
   depends on #549 resolving the oracle path if the preview shares that helper).
3. **#551** — `rebalance()` implementation (adds new function; no overlap
   with #549/#550 unless `_routeDeposit` is refactored together).
4. **#552** — multi-DEX adapter seam (`SWAP_ROUTER` → pluggable
   `IBasketSwapAdapter`; touches every call to `SWAP_ROUTER.exactInputSingle`
   in `BasketVault._routeDeposit`, `_sellProportional`, emergency unwind,
   and `rescueTokens`). **This is the highest-impact change and should land
   last in Phase B because it rewrites the swap call sites used by all other
   issues.**
5. **#553** — Aerodrome adapter + Uniswap V4 adapter implementations
   (introduces new Solidity files; no hot-file overlap with #549–#551 except
   the seam interface from #552). Depends on #552.

**Hot files in Phase B:**

| File | Issues that touch it |
|---|---|
| `contracts/vaults/BasketVault.sol` | #549, #550, #551, #552 |
| `contracts/interfaces/ISwapRouter.sol` | #552 (may be replaced by `IBasketSwapAdapter`) |
| `contracts/interfaces/IUniswapV3Pool.sol` | #552/#553 (add `IUniswapV4Pool` / `IAerodromePool`) |
| new `contracts/adapters/AerodromeSwapAdapter.sol` | #553 |
| new `contracts/adapters/UniswapV4SwapAdapter.sol` | #553 |
| `contracts/PortfolioRouter.sol` | #552 if the eligibility gate changes |
| `contracts/VaultRegistry.sol` | #554 (router-eligibility flip) |

### Phase C — VaultRegistry router-eligibility flip (issue #554)

After Phase B lands, the basket vaults satisfy all ADR prerequisites. Issue
#554 calls `VaultRegistry.setRouterEligible` for `ProtocolAssetVault` and
`AgentTokenVault` and updates the router's default + voted weight vectors.

Hot files:
- `contracts/VaultRegistry.sol` — `setRouterEligible` / `routerEligibleCount`
- `contracts/PortfolioRouter.sol` — `setWeights` / `setDefaultWeights` /
  `defaultWeightsLength`
- `contracts/script/DeployDemoExtraVaults.s.sol` — `_applySingleVaultWeights`
  currently sets a single 10 000 bps leg; Phase C changes this to a
  multi-vault weight vector matching the new router-eligible count

### Phase D — deSPXA RWA vault (issues #555, #558)

The RWA/Thematic vault (PRD §11.4) uses Centrifuge deSPXA as its single asset.
Entry/exit is Aerodrome-only (the primary ERC-7540 NAV redeem is async+KYC
and is forbidden for a permissionless vault). The Chronicle NAV oracle gates
pricing. Hot files:

| File | Notes |
|---|---|
| new `contracts/vaults/RwaVault.sol` (or a `BasketVault` subclass) | ADR #548 resolves the contract shape |
| `contracts/script/DeployDemoExtraVaults.s.sol` | Currently deploys a plain `RobotMoneyVault` as the RWA placeholder (line ~145 `batchB.rwaVault`); Phase D replaces it with the real RWA vault |
| new `contracts/adapters/AerodromeSwapAdapter.sol` | Shared with Phase B #553 |
| new `contracts/oracles/ChronicleOracleAdapter.sol` | deSPXA NAV oracle |
| `config/dex-pools.json` | New entry for the deSPXA/USDC Aerodrome pool |

### Phase E — Fork ingest (issues #556, #557)

The hermetic fork fixture (`testing/fixtures/fork-state/CURRENT.*`) currently
ingests only the addresses listed in
`testing/ethereum-testnet/config/fork-block.json::ingested_addresses`. None of
the Aerodrome pools, Uniswap V4 pools, or DEX pool contracts for the new basket
tokens (BNKR, JUNO, ROBOTMONEY/deSPXA) are in that list.

Hot files:

| File | Notes |
|---|---|
| `testing/ethereum-testnet/config/fork-block.json` | Add new pool addresses to `ingested_addresses` |
| `testing/fixtures/fork-state/` | New `CURRENT.anvil-state` + `CURRENT.json` after re-snapshotting |
| `config/dex-pools.json` | Add Aerodrome + V4 pool entries for the new tokens |

**Important:** `fork-block.json` and `testing/fixtures/fork-state/CURRENT.json`
must stay in lockstep (the CI manifest validator asserts alignment). Any
re-snapshot advances `block_number` in both files simultaneously.

### Phase F — Demo seeding (issues #559–#562)

Hot files:

| File | Notes |
|---|---|
| `testing/smoke-test/src/lib.rs` | `Fixture::seed_demo_depositors` (line ~1393) — extend to seed all four vaults, not just the primary; `DappStack::boot` (line ~2641) and the `DappStack::boot` call at line ~2996 drive seeding |
| `contracts/script/DeployDemoExtraVaults.s.sol` | Weight vector in `_applySingleVaultWeights` must become multi-vault after Phase C |
| `testing/smoke-test/src/bin/demo-seed-depositors.rs` | Standalone binary for out-of-band seeding; must accept per-vault targets |

### Phase G — Explorer + dapp surfaces (issues #563–#566)

Hot files are isolated to `clients/` and `services/`; no overlap with Phases
B–F. Downstream issues should watch for VITE env vars added for the new vault
addresses (the four-vault catalog expands the set wired at
`testing/smoke-test/src/lib.rs` ~lines 2218–2380).

### Phase H — Smoke-test and fork-e2e coverage (issues #567–#568)

Hot files:

| File | Notes |
|---|---|
| `testing/fork-e2e-rust/tests/basket_vault.rs` (new) | Multi-DEX deposit/redeem round-trip |
| `testing/smoke-test/tests/demo_seeding.rs` | Extended assertions for four-vault TVL |
| `testing/smoke-test/tests/full_stack_demo_tvl.rs` | `DappStack::boot` TVL assertions per vault |

---

## 3. BasketVault swap seam — Aerodrome + Uniswap V4 adapter insertion point

`BasketVault.sol` currently hardcodes Uniswap V3 swap mechanics via the
`SWAP_ROUTER` immutable (`ISwapRouter public immutable SWAP_ROUTER`, line 98).
All swap call sites use the same interface:

```
SWAP_ROUTER.exactInputSingle(ISwapRouter.ExactInputSingleParams({...}))
```

The four affected call sites are:

| Method | Line range | Direction |
|---|---|---|
| `_routeDeposit` | ~324–336 | USDC → basket token |
| `_sellProportional` | ~415–427 | basket token → USDC |
| emergency unwind (`emergencyUnwind`) | ~763–775 | basket token → USDC |
| emergency unwind with override | ~796–808 | basket token → USDC |

**Seam insertion plan (ADR #547 will finalise):** introduce a
`IBasketSwapAdapter` interface with a single `swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address recipient) returns (uint256 amountOut)` method. Each `AssetInfo` struct entry gains an `adapter` address field alongside the existing `pool` and `swapFee`. The `BasketVault` constructor receives a `defaultAdapter` address (the existing Uniswap V3 adapter) so the current deploy path is unchanged. Aerodrome and Uniswap V4 adapters are deployed separately and passed per-asset via `addAsset`.

The TWAP seam follows the same pattern: `_twapUsdcValue` currently calls
`IUniswapV3Pool(pool).observe([twapWindow, 0])`. Each adapter will expose a
`twapPrice(address pool, address token, uint32 window) returns (uint256 usdcPerToken)` helper so the oracle path is adapter-aware.

**Files changed by the multi-DEX seam (issue #552):**

- `contracts/vaults/BasketVault.sol` — replace all four `SWAP_ROUTER.exactInputSingle` call sites; add `adapter` field to `AssetInfo`; update `addAsset` signature
- `contracts/interfaces/ISwapRouter.sol` — kept for the Uniswap V3 adapter wrapper; not the shared interface
- new `contracts/interfaces/IBasketSwapAdapter.sol`
- new `contracts/adapters/UniswapV3SwapAdapter.sol` — thin wrapper over existing `ISwapRouter`
- new `contracts/adapters/AerodromeSwapAdapter.sol`
- new `contracts/adapters/UniswapV4SwapAdapter.sol`
- `contracts/vaults/ProtocolAssetVault.sol`, `AgentTokenVault.sol` — update constructor if they forward `swapRouter_` directly

---

## 4. VaultRegistry router-eligibility flip path

The eligibility gate is implemented in `contracts/VaultRegistry.sol`. Key
surfaces:

| Function / storage | Purpose |
|---|---|
| `routerEligibleCount` (uint256, line ~92) | Count of vaults opted in; must match `PortfolioRouter.defaultWeightsLength()` when a router is linked |
| `setRouterEligible(address vault, bool eligible)` (line ~214) | Opt a registered vault in or out; guarded by `ADMIN_ROLE` |
| `isRouterEligible(address vault)` (line ~297) | Read by `PortfolioRouter.setWeights` — reverts if false |
| `setRouter(address)` (line ~254) | Links a `PortfolioRouter`; validates `defaultWeightsLength == routerEligibleCount` |

**Coupling to `PortfolioRouter`:**

`PortfolioRouter.setDefaultWeights(address[] vaults, uint256[] bps)` (line ~279)
must be called with a vector whose length matches the eligible count before or
after calling `setRouterEligible`. The current demo sets a single-leg default
via `_applySingleVaultWeights` in `DeployDemoExtraVaults.s.sol`. Extending to
three router-eligible vaults requires:

1. `setRouterEligible(protocolVault, true)` → `routerEligibleCount` = 2
2. `setRouterEligible(agentVault, true)` → `routerEligibleCount` = 3
3. `setDefaultWeights([primaryVault, protocolVault, agentVault], [bps1, bps2, bps3])`
4. `setWeights([primaryVault, protocolVault, agentVault], [bps1, bps2, bps3])`

Steps 1 and 2 revert if the linked router's `defaultWeightsLength` does not
match the new count. The safe sequence is: update `defaultWeights` (step 3)
before or after each `setRouterEligible` call — step 3 must satisfy the
length invariant at the time each `setRouterEligible` runs.

**`isPrototype()` is removed.** The historical `isPrototype()` /
`prototypeOverride` / `nonPrototypeAttested` machinery was removed in issue
#475. Production-readiness is signalled exclusively via
`VaultRegistry.isRouterEligible`. See `contracts/test/PortfolioRouter.t.sol`
line ~876 for the rationale comment.

---

## 5. Demo seed + DappStack::boot path

The seeding path today:

1. `testing/smoke-test/src/lib.rs` `Fixture::with_deploy_env` (~line 460):
   runs Deploy + VaultRegistry + PortfolioRouter + Governance + RmToken scripts,
   then calls `run_forge_deploy_demo_extra_vaults` (~line 918) which invokes
   `contracts/script/DeployDemoExtraVaults.s.sol`.
2. `DappStack::boot` (~line 2641) calls `fixture.seed_demo_depositors(count,
   per_user_usdc)` (~line 2996).
3. `Fixture::seed_demo_depositors` (~line 1393) loops over `count` deterministic
   EOAs, funds each with ETH + USDC, approves the router, and calls
   `PortfolioRouter.deposit(amount, [])`.

**What must change for the four-vault demo:**

- `seed_demo_depositors` deposits through the router, so it automatically
  follows the voted/default weight vector. Once the Phase C eligibility flip
  sets a multi-vault weight vector, `seed_demo_depositors` seeds all
  router-eligible vaults without any structural change to the Rust code.
- The standalone `testing/smoke-test/src/bin/demo-seed-depositors.rs` binary
  (invoked by `make demo-seed-depositors`) follows the same deposit path.
- `DeployDemoExtraVaults.s.sol::_applySingleVaultWeights` (~line in
  `_applySingleVaultWeights` function) currently hardcodes a single 10 000 bps
  leg. After Phase C, this must write a multi-vault vector matching the new
  eligible vaults.
- The RWA vault (deSPXA) is NOT router-eligible (ADR #548 mandates direct
  deposit bypassing the router; the router must not split weight to it). Seeding
  the RWA vault requires a separate `fund + direct deposit` path outside
  `seed_demo_depositors`.

**DappStack VITE env wiring** (hot file `testing/smoke-test/src/lib.rs` ~lines
2218–2380): the `run_forge_deploy_demo_extra_vaults` call already populates
`Fixture.demo_extra_vaults` with all four vault addresses. The four VITE
pass-through blocks need entries for `VITE_PROTOCOL_VAULT_ADDRESS`,
`VITE_AGENT_VAULT_ADDRESS`, and `VITE_RWA_VAULT_ADDRESS` (the exact var names
are set by issue #563).

---

## 6. Fork-ingest manifest — required DEX pools

The hermetic fork fixture at `testing/fixtures/fork-state/CURRENT.*` is derived
from Base mainnet block 46698556 (see
`testing/ethereum-testnet/config/fork-block.json`). The current
`ingested_addresses` list covers USDC, wETH, the existing Uniswap V3 pools for
wETH/USDC, cbBTC/USDC, and wSOL/USDC, plus the Aave/Compound/Morpho adapters.

**Not yet ingested (required by Real four-vault demo):**

| Token | Pool / DEX | Notes |
|---|---|---|
| BNKR (BANKR) | Uniswap V3 BNKR/USDC | Address TBD — `config/agent-token-shortlist.json` records `"TODO: confirm Base mainnet BANKR token + USDC V3 pool"` |
| JUNO | Uniswap V4 JUNO/USDC | Uniswap V4 on Base; pool address TBD — ADR-0001 revision (#543) must resolve |
| ROBOTMONEY ($RM) | Uniswap V4 or Aerodrome $RM/USDC | `config/agent-token-shortlist.json` records `"TODO: wire deployed RmToken address"` |
| deSPXA (Centrifuge) | Aerodrome deSPXA/USDC secondary market | ADR #548 resolves pool address; no primary ERC-7540 NAV redeem (async+KYC) |
| Aerodrome router | `Router.sol` / `PoolFactory.sol` | Deployed contracts on Base; address needed for adapter wiring |
| Uniswap V4 PoolManager | `0x...` | Base-mainnet PoolManager address; needed for the V4 adapter |
| Chronicle oracle | `IChronicle` (for deSPXA NAV) | ADR #548 resolves oracle address |

**Existing ingested pool addresses** (for reference, already in `fork-block.json`):

| Pool | Address |
|---|---|
| wETH/USDC (Uniswap V3) | `0xd0b53D9277642d899DF5C87A3966A349A798F224` |
| cbBTC/USDC (Uniswap V3) | `0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef` |
| wSOL/USDC (Uniswap V3) | `0x170De01C2b662b7d54BFFd400bc35283B8671e38` |
| cbBTC token | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
| wSOL token | `0x1C61629598e4a901136a81BC138E5828dc150d67` |
| Morpho USDC | `0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca` |
| Aave aUSDC v3 | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` |

### RMPC_FORK_RPC_URL — archive-RPC dependency

`RMPC_FORK_RPC_URL` is referenced in `docs/development/environments.md` as an
optional environment variable used by `scripts/snapshot-fork.sh` to capture a
new fork snapshot. It is **not** used at demo boot time; the demo harness loads
the checked-in `CURRENT.anvil-state` hermetically with no live RPC.

When the Real four-vault demo issues add new pool addresses to
`ingested_addresses`, a new snapshot must be captured. `snapshot-fork.sh`
defaults to the public `https://base-rpc.publicnode.com` endpoint, which serves
`eth_getStorageAt` / `eth_getCode` calls on recent blocks without archive depth.
Because the fork is pinned to block 46698556 (approximately 4 weeks old at the
time of this scout), a public RPC may succeed if publicnode's retention covers
that block, but it is not guaranteed. A private archive endpoint (set via
`RMPC_FORK_RPC_URL`) removes the retention risk for future snapshot updates.

**Archive RPC is NOT a blocker for CI, the dapp demo, or the fork-e2e suite.**
All three paths load the checked-in fixture hermetically. The archive RPC is
only needed when a human operator re-runs `snapshot-fork.sh` to advance the
pinned block or add new ingested addresses.

---

## 7. Required serialization order

```
Phase A: ADRs (#542–#548)         — parallel-safe with each other
    ↓ all ADRs approved
Phase B: BasketVault hardening     — serialized within:
         #549 preview (slippage-adjusted previewRedeem)
         #550 TWAP cap enforcement
         #551 rebalance()
         #552 multi-DEX seam (IBasketSwapAdapter)  ← last in B; highest churn
         #553 Aerodrome + V4 adapters               ← depends on #552
    ↓
Phase D: deSPXA RWA vault (#555, #558)
         — may run in parallel with Phase B #549–#551 if ADR #548 is approved;
           depends on #552/#553 for Aerodrome adapter
Phase E: Fork ingest (#556, #557)
         — may be prepared in parallel with Phase B;
           final snapshot waits until pool addresses from Phase D/#553 are known
    ↓
Phase C: Router-eligibility flip (#554)
         — must follow Phase B completion (hardening done)
         — must follow Phase E (fork has real pool state for fork-e2e assertions)
    ↓
Phase F: Demo seeding (#559–#562)
         — depends on Phase C (router weights multi-vault)
         — depends on Phase D (deSPXA vault deployed)
Phase G: Explorer + dapp surfaces (#563–#566)
         — can start once vault addresses are known (post Phase D)
Phase H: Smoke + fork-e2e coverage (#567–#568)
         — must follow Phase F (seeding complete)
```

---

## 8. File-level coupling matrix

| Issue pair | Shared hot files | Verdict |
|---|---|---|
| #549 ↔ #550 | `BasketVault.sol` `_deposit` path | Serialise (#549 first, then #550 rebases) |
| #549 ↔ #551 | `BasketVault.sol` (different functions: preview vs rebalance) | Parallel-safe with care; second-merger rebases |
| #550 ↔ #551 | `BasketVault.sol` `_deposit` path | Parallel-safe with care |
| #552 ↔ any of #549–#551 | `BasketVault.sol` all swap call sites | **Serialise — #552 last in Phase B** |
| #553 ↔ #552 | `IBasketSwapAdapter`, adapter files | Depends on #552 (interface must land first) |
| #554 ↔ #552/#553 | `VaultRegistry.sol`, `PortfolioRouter.sol` | Parallel-safe; eligibility flip is additive |
| #555/#558 ↔ #552/#553 | Aerodrome adapter | Depends on #553 |
| #556 ↔ #557 | `fork-block.json`, `CURRENT.*` | Serialise (single snapshot file) |
| Phase F seeding ↔ Phase C flip | `DeployDemoExtraVaults.s.sol` `_applySingleVaultWeights` | Serialise (seeding follows eligibility flip) |

---

## 9. Files cited in this scout

Every file path below exists in the tree at the time of this commit:

- `contracts/vaults/BasketVault.sol`
- `contracts/vaults/ProtocolAssetVault.sol`
- `contracts/vaults/AgentTokenVault.sol`
- `contracts/VaultRegistry.sol`
- `contracts/PortfolioRouter.sol`
- `contracts/script/DeployDemoExtraVaults.s.sol`
- `contracts/interfaces/ISwapRouter.sol`
- `contracts/interfaces/IUniswapV3Pool.sol`
- `contracts/test/PortfolioRouter.t.sol`
- `config/dex-pools.json`
- `config/agent-token-shortlist.json`
- `testing/ethereum-testnet/config/fork-block.json`
- `testing/fixtures/fork-state/CURRENT.json`
- `testing/fixtures/fork-state/CURRENT.anvil-state`
- `testing/smoke-test/src/lib.rs`
- `testing/smoke-test/src/bin/demo-seed-depositors.rs`
- `testing/smoke-test/tests/demo_seeding.rs`
- `testing/smoke-test/tests/full_stack_demo_tvl.rs`
- `docs/prd.md`
- `docs/implementation-plan.md`
- `docs/technical/basket-vault-gap-report.md`
- `docs/technical/demo-seeding-seams.md`
- `docs/adr/ADR-0001-mvp-agent-token-shortlist.md`
