# ADR — Demo seeding seam map (seed-script, dapp-balance, RM-token, faucet)

> Scope: dev-scout report for issue #472, covering the **Demo seeding** phase
> of the implementation plan. This document is documentation only: no seed
> script, dapp balance, RM-token, or faucet behaviour is introduced or
> changed here. The scout's product is a file-level seam map and a
> parallel-safety call for the four downstream feature issues:
>
> - #463 — show wallet balances for USDC, ETH, RM, and vault receipts on the main dapp page
> - #465 — seed all three vaults, simulated depositors, and multi-vault router weights
> - #466 — wire the RM token address into the dapp and add a Base ETH gas faucet drip
> - #433 — (closed) refactor: remove VITE_FEATURE_FLAGS gating and consolidate router deposit to RouterDepositTab
>
> Canonical inputs: `docs/implementation-plan.md`, `docs/prd.md`,
> `docs/architecture.md` §4 (Router) and §5.3 (Human dapp).

## 1. Status

Accepted for implementation planning. Authored 2026-05-26 against the current
contracts, dapp, and smoke-test harness. #433 is already merged; the open
work is #463, #465, #466.

---

## 2. Deploy / seed entry points today

The smoke-test full-stack harness is the single canonical deploy and seed
path for the demo (`make testnet` → `cargo run -p smoke-test --
--full-stack ...`, see `Makefile` and
`testing/smoke-test/src/bin/smoke-test.rs`).

`testing/smoke-test/src/lib.rs` (`Fixture::with_deploy_env`,
~line 460–~920) is the only orchestrator. In order it:

1. Runs `contracts/script/Deploy.s.sol` → `RobotMoneyVault`, real
   AaveV3/Compound/Morpho adapters, `RobotMoneyGateway`, agent role grant.
   Outputs `deployment.json` (vault, USDC, gateway, adapters).
2. Runs `contracts/script/DeployVaultRegistry.s.sol` → `VaultRegistry`,
   registers `RobotMoneyVault` as the first active vault. Outputs
   `registry.json`.
3. Runs `contracts/script/DeployPortfolioRouter.s.sol` → `PortfolioRouter`
   with **initial weights = 10 000 bps to `RobotMoneyVault`**
   (`DeployPortfolioRouter.s.sol` constant `INITIAL_VAULT_WEIGHT_BPS`).
   Outputs `router.json`.
4. Runs `contracts/script/DeployRouterGovernance.s.sol` →
   `RouterGovernance` bound to the router. Outputs `governance.json`.
5. Runs `contracts/script/DeployRmToken.s.sol` → `RmToken`, mints the
   entire initial supply to `HARNESS_USDC_HOLDER_ADDRESS_HEX`. Outputs
   `rm-token.json`. (See `Fixture::fund_rm_token`,
   `testing/smoke-test/src/lib.rs:1176`.)
6. Funds ETH for the agent and pauser from the deployer EOA.
7. Funds USDC for the agent (500 000 USDC) via a real ERC-20 transfer
   from `HARNESS_USDC_HOLDER` — no `anvil_*` cheats.

Forge scripts are invoked via `run_forge_deploy*` helpers in the same
file; their env-var contracts are documented in each Solidity script's
header.

### Where the dapp bundle gets these addresses

The Vite bundle is built with `VITE_*` env vars set in the smoke-test
process before the dapp container starts. Today, set by
`testing/smoke-test/src/lib.rs` ~line 2218 / 2236 / 2314 / 2371:

| `VITE_*` var | Source | Status |
|---|---|---|
| `VITE_GATEWAY_ADDRESS` | `deployment.json` | wired |
| `VITE_VAULT_ADDRESS` | `deployment.json` | wired |
| `VITE_GATEWAY_EXPECTED_CODE_HASH` | runtime hash | wired |
| `VITE_REGISTRY_ADDRESS` | `registry.json` | wired |
| `VITE_ROUTER_ADDRESS` | `router.json` | wired |
| `VITE_GOVERNANCE_ADDRESS` | `governance.json` | wired |
| `VITE_DEVNET_RPC_URL` / `VITE_DAPP_URL` / `VITE_EXPLORER_API_URL` | CLI / tunnel | wired |
| `VITE_FAUCET_HARNESS_PRIVATE_KEY` | hard-coded harness key | wired |
| **`VITE_RM_TOKEN_ADDRESS`** | `rm-token.json` | **NOT yet wired** ← #466 hot file |

The dapp already reads `VITE_RM_TOKEN_ADDRESS` (see
`clients/dapp/src/main.tsx:67`, `lib/buildEnvValidation.ts`), and the RM
faucet drip path is fully implemented in the dapp
(`lib/faucetClient.ts:dripRmToken`, `useFaucetBalances.harnessRm`,
`FaucetTabView` gated on `rmTokenAddress` prop). The single missing wire
is exporting the deployed `RmToken` address from
`Fixture.rm_token_hex()` into the dapp container's env at the four
call-sites above. **This is the canonical landing seam for #466.**

---

## 3. Dapp balance/data path today

Per `docs/security/dapp-topology.md` §2 the dapp opens **no HTTP RPC of
its own**. Two read-classes:

- **Live-chain reads** — via wagmi `useReadContract` → user's wallet
  provider. Today only used by the FaucetTab USDC/RM `balanceOf`
  preflight (`clients/dapp/src/lib/useFaucetBalances.ts`). Pattern:
  ERC-20 `balanceOf(addr)` parameterised by token address from
  `VITE_*_ADDRESS`.
- **Explorer reads** — via `fetch` to `VITE_EXPLORER_API_URL`. Vault
  shares come from `GET /v1/accounts/:address/positions`
  (`clients/dapp/src/lib/usePositions.ts`), which returns one entry per
  vault with `shares` as a decimal string.

For issue **#463** (show USDC, ETH, RM, vault-receipt balances on the
main page), each balance must be classified:

| Asset | Read class | Existing hook to extend / mirror | Risk |
|---|---|---|---|
| USDC | live-chain (wallet) | `useFaucetBalances` already does ERC-20 `balanceOf(user)` against `VITE_USDC_ADDRESS` | low — copy the same hook shape |
| ETH | live-chain (wallet) | none — wagmi `useBalance` (native) | low — additive hook |
| RM | live-chain (wallet) | `useFaucetBalances.harnessRm` reads `balanceOf(harness)`; #463 wants `balanceOf(user)` | low — additive hook with same ABI |
| Vault receipts | explorer | `usePositions` already returns the array | low — already used by `PortfolioPosition.tsx` |

**Design recommendation for #463:** add a single new
`clients/dapp/src/lib/useWalletBalances.ts` that returns
`{ usdc, eth, rm, positions }` shaped to match `useFaucetBalances` so
the wallet card and the FaucetTab share the same ABI/chain-id pattern.
Render-only component lives next to `PortfolioPosition.tsx`.

---

## 4. RM token address wiring (issue #466)

State today: deployment side is **fully wired** (deploy script + smoke
harness + JSON + `Fixture::rm_token_hex`). Dapp consumer side is
**fully wired** (`main.tsx` reads `VITE_RM_TOKEN_ADDRESS`, plumbs to
`AgentsPanel`/`FaucetTabView`; faucet client implements
`dripRmToken`).

**The only missing seam** is in
`testing/smoke-test/src/lib.rs` around lines 2218–2380: the four code
sites that pass `VITE_*` into (a) the dapp Docker container env, (b)
the `vite build` invocation for the tunnel build, and (c) the
`vite build` invocation for the cleanup-stack rebuild. Each site needs
one additional `("VITE_RM_TOKEN_ADDRESS", fixture.rm_token_hex())`
entry. This is the entire scope of #466's harness work.

Base ETH gas faucet drip (the second half of #466) does **not** exist
yet. The current `FaucetTab` drips USDC and RM only. The seam is
clean:

- New `dripBaseEth(...)` next to `dripUsdc` / `dripRmToken` in
  `clients/dapp/src/lib/faucetClient.ts` — same wallet-provider
  broadcast pattern, but signs `eth_sendTransaction` with `value` set
  rather than calling ERC-20 `transfer`.
- New constant `FAUCET_DRIP_AMOUNT_BASE_ETH` in
  `clients/dapp/src/lib/chainClassifier.ts` to match
  `FAUCET_DRIP_AMOUNT_USDC` / `FAUCET_DRIP_AMOUNT_RM`.
- New button in `FaucetTabView`, gated on harness ETH `balance >=
  amount + gas reserve`. `useFaucetBalances` extends with
  `harnessEth`.
- No new env var; the existing
  `VITE_FAUCET_HARNESS_PRIVATE_KEY` already controls the signer and
  the harness EOA is already ETH-funded via
  `fund_eth_from_deployer` in the smoke-test fixture.

---

## 5. Simulated depositors and multi-vault router weights (issue #465)

Today the harness only seeds **one** ERC-4626 vault (`RobotMoneyVault`)
and **one** weight (10 000 bps to that vault). #465 wants the demo to
show the multi-vault router actually splitting deposits across three
vaults.

Three independent seam clusters:

1. **Register additional vaults.** The contracts and registry already
   support N vaults; `BasketVault.sol` exists but per
   `docs/implementation-plan.md` §"Basket vault production path" the
   protocol-asset and agent-token vaults remain ADR-blocked. For a
   *demo-only* seed the safe play is to register two additional
   `RobotMoneyVault` instances (passthrough adapter or duplicate
   Aave/Compound/Morpho mix). Seam:
   `testing/smoke-test/src/lib.rs` `run_forge_deploy_*` block — clone
   `Deploy.s.sol` invocation pattern, append `registerVault` calls
   through `DeployVaultRegistry.s.sol` (already idempotent).
2. **Multi-vault weights.** `DeployPortfolioRouter.s.sol` hard-codes a
   single 10 000 bps weight. Replace with an env-driven vector — env
   vars `INITIAL_VAULTS` (comma-sep) and `INITIAL_WEIGHTS_BPS` parsed
   by the script. Hot file:
   `contracts/script/DeployPortfolioRouter.s.sol` lines ~30–120 (the
   `Deployed` struct returns single `vault`/`bps` today).
3. **Simulated depositors.** No depositor-simulation harness exists
   today. The clean seam is a new Rust helper next to
   `Fixture::fund_usdc` (which already does `signed ERC-20 transfer`
   from `HARNESS_USDC_HOLDER`): a `Fixture::seed_demo_depositors(n)`
   that loops over deterministic EOAs, funds each with USDC, then
   submits gateway-routed deposits with weighted amounts. This re-uses
   the gateway deposit path already exercised by suite-11b. No new
   contract or dapp surface required.

---

## 6. File-level coupling and parallel-safety

| Pair | Shared hot files | Recommendation |
|---|---|---|
| #463 ↔ #466 | `clients/dapp/src/components/FaucetTabView.tsx` (#466 adds ETH button); `clients/dapp/src/lib/useFaucetBalances.ts` (#466 adds `harnessEth`); `chainClassifier.ts` (constants). #463 only edits new files plus `PortfolioPosition.tsx`. | **Parallel-safe.** No hot-file overlap. |
| #463 ↔ #465 | None. #463 is dapp-only; #465 is smoke-test + Solidity deploy script. | **Parallel-safe.** |
| #466 ↔ #465 | `testing/smoke-test/src/lib.rs` — both touch the deploy/env-export block (~lines 700–900 for #465 vault deploys, ~lines 2218–2380 for #466 VITE wiring). | **Parallel-safe with care.** Different line ranges; merge order shouldn't matter, but second-merger should rebase and re-run `cargo build -p smoke-test` to catch struct-rename collisions. |
| #466 ↔ #433 | `RouterDepositTab.tsx`, feature-flag removal. #433 already merged. | **No conflict.** |
| #465 ↔ #433 | None. | **No conflict.** |

**Serialized work:** none required across the open three. All three can
run in parallel; the canonical merge order if a tie-break is needed is
**#466 first** (single-line env wiring, smallest blast radius) →
**#463** (additive new hook + new component) → **#465** (largest, most
likely to surface secondary issues with multi-vault weights vs. the
basket-vault ADR work).

---

## 7. Discovered risks / out-of-scope items for downstream issues

- **#465 vs. basket-vault ADRs.** Registering `ProtocolAssetVault` and
  `AgentTokenVault` in the demo is blocked by the open ADRs in
  `docs/technical/basket-vault-gap-report.md`. #465 must either ship
  with three `RobotMoneyVault` instances (passthrough-style demo) or
  wait. Recommend the former.
- **#466 production-build safety.** `VITE_RM_TOKEN_ADDRESS` is read
  but not validated by `buildEnvValidation.ts` against
  `VITE_ENV_CLASS`. If the demo ever publishes a mainnet build, the
  RM token address must be either unset or pinned. Out of scope for
  #466 but flag for security review.
- **#463 wallet ETH read.** wagmi `useBalance` polls the wallet
  provider; per the dapp-topology rule this is fine, but the polling
  interval must not be aggressive (recommend `staleTime: 10_000` like
  `useFaucetBalances`).
- **No multi-vault seed in suite-11b.** The agent-onboarding suite
  exercises the gateway, not router-split deposits. #465 should add a
  smoke test that asserts at least one router-split deposit succeeds
  against the three-vault config so the demo is regression-protected.

---

## 8. Acceptance — files cited in this scout

Every file path referenced above exists in the tree as of this commit:

- `Makefile`
- `testing/smoke-test/src/bin/smoke-test.rs`
- `testing/smoke-test/src/lib.rs`
- `contracts/script/Deploy.s.sol`
- `contracts/script/DeployVaultRegistry.s.sol`
- `contracts/script/DeployPortfolioRouter.s.sol`
- `contracts/script/DeployRouterGovernance.s.sol`
- `contracts/script/DeployRmToken.s.sol`
- `contracts/PortfolioRouter.sol`
- `contracts/vaults/BasketVault.sol`
- `clients/dapp/src/main.tsx`
- `clients/dapp/src/lib/buildEnvValidation.ts`
- `clients/dapp/src/lib/faucetClient.ts`
- `clients/dapp/src/lib/useFaucetBalances.ts`
- `clients/dapp/src/lib/usePositions.ts`
- `clients/dapp/src/lib/chainClassifier.ts`
- `clients/dapp/src/lib/onboardingSeed.ts`
- `clients/dapp/src/components/FaucetTabView.tsx`
- `clients/dapp/src/components/PortfolioPosition.tsx`
- `clients/dapp/src/components/AgentsPanel.tsx`
- `clients/dapp/.env.example`
- `docs/technical/basket-vault-gap-report.md`
- `docs/security/dapp-topology.md`

A reviewer can run `git ls-files` against any of the above to confirm
existence.
