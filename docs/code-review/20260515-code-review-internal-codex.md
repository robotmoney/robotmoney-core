# Robot Money MVP Code Review

**Date:** 2026-05-15 15:46:25 UTC  
**Reviewer:** Codex  
**Scope:** Static cross-domain review of contracts, Rust client, dapp, explorer indexer/API, docs, and CI configuration.  
**Primary anchors:** `docs/prd.md`, `docs/architecture.md`, `docs/technical/security-model.md`, `docs/development/ci-suites.md`.

## Executive Summary

The MVP has strong signs of disciplined iteration: many previously reviewed vault accounting issues are fixed, the codebase is heavily tested, and the docs establish useful safety boundaries. The largest current risks are now integration drift rather than isolated implementation style.

The two highest-priority blockers are:

1. The explorer indexer ABI is out of sync with the current Solidity contracts, so key policy, registry, and governance events will not be indexed.
2. The Portfolio Router preview and write paths disagree about vault availability; users can preview a leg as unavailable and still deposit through it.

I did not run the full test suite for this review. This is a static review with file/line evidence.

## Findings

### 1. HIGH — Explorer indexer event ABI has drifted from current contracts

**Files:** `services/explorer-indexer/src/abi.rs:18`, `services/explorer-indexer/src/abi.rs:48`, `services/explorer-indexer/src/abi.rs:100`, `contracts/gateway/interfaces/IGateway.sol:74`, `contracts/VaultRegistry.sol:67`, `contracts/RouterGovernance.sol:106`

The indexer declares event signatures that no longer match the Solidity sources:

- `AgentAuthorized` in Solidity includes `owner`; indexer expects no owner.
- `AgentRevoked` in Solidity includes `owner`; indexer expects only `agent`.
- `VaultRegistered` in Solidity emits `(address,string,address)`; indexer expects `(address,string,string,uint256,uint64)`.
- `VaultStatusChanged` in Solidity emits `(address,uint8,uint256)` with indexed status; indexer expects `(address,uint8,uint8,uint64)`.
- `ProposalCreated`, `VoteCast`, and `ProposalExecuted` differ between `RouterGovernance.sol` and `IRouterGovernanceEvents`.

Because topic0 includes the full event type list, these logs are not just decoded incorrectly; most will be missed entirely. That breaks the product promise that policy, vault status, governance, and allocation state are observable.

**Recommendation:** Generate or validate indexer ABI from compiled contract artifacts in CI. Add a test that compares every indexer topic hash against the corresponding Foundry artifact ABI, not only against the local `sol!` declaration.

### 2. HIGH — Portfolio Router deposit ignores registry status even though preview marks inactive legs unavailable

**Files:** `contracts/PortfolioRouter.sol:221`, `contracts/PortfolioRouter.sol:304`

`previewDeposit` calls `registry.getVault` and marks non-`Active` vaults unavailable. `_depositTo` never repeats that status check; it just approves and calls `IERC4626(vault).deposit`.

If the registry marks a vault `Paused` or `Retired` while the vault contract itself still accepts deposits, the write path can send user funds into a destination the preview told the user was unavailable.

**Recommendation:** In `_depositTo`, fetch registry status for each leg and revert unless it is `Active`. Add a regression test where registry status is paused but the vault contract accepts deposits.

### 3. HIGH — Emergency pause blocks withdrawals after emergency asset recovery

**Files:** `contracts/RobotMoneyVault.sol:395`, `contracts/RobotMoneyVault.sol:610`

`emergencyWithdraw()` pauses the vault, then pulls assets out of adapters. But `_withdraw` is guarded by `whenNotPaused`, so users cannot redeem while the vault is paused, even if the emergency action successfully moved assets into idle USDC.

This conflicts with the architecture/PRD lifecycle language that incident controls should preserve withdrawal rights where possible.

**Recommendation:** Split pause semantics into `depositsPaused` and `withdrawalsPaused`, or allow withdrawals during emergency pause when assets are available. Add a test: deposit, emergency withdraw adapters, then user redeems while new deposits remain blocked.

### 4. MEDIUM — Portfolio Router strands USDC rounding dust with no rescue path

**Files:** `contracts/PortfolioRouter.sol:304`, `contracts/PortfolioRouter.sol:335`

Each leg amount is floored with `(amount * bps) / 10000`. Any remainder stays in the router. There is no event, sweep, accounting variable, or rescue function for USDC held by the router.

For a 6-decimal asset the dust per deposit is small, but it is permanent and accumulates. It also violates the expectation that the router is a pass-through allocator rather than a custodian.

**Recommendation:** Assign the rounding remainder to the final non-zero leg, or explicitly track and sweep dust to the next deposit. Add an invariant that router USDC balance is zero after successful deposits.

### 5. MEDIUM — Gateway and interface docs promise multi-vault policy, but implementation only supports the pinned vault

**Files:** `contracts/gateway/interfaces/IGateway.sol:35`, `contracts/gateway/interfaces/IGateway.sol:46`, `contracts/gateway/RobotMoneyGateway.sol:478`, `contracts/gateway/RobotMoneyGateway.sol:599`

The interface says empty `allowedDestinations` permits any registered vault and empty `allowedSourceVaults` permits any registered vault. The implementation accepts only `vaultContract` or `routerContract` for deposits, and only `vaultContract` for withdrawals.

This is a product-surface mismatch. Agents cannot act across registered vaults directly, and policy text suggests broader behavior than the contract enforces.

**Recommendation:** Either update the interface/docs to say the gateway is pinned-vault plus router only, or inject/check `VaultRegistry` and support registered vaults explicitly.

### 6. MEDIUM — `rmpc withdraw` preflight reuses deposit caps instead of withdrawal caps

**Files:** `clients/rust-payment-client/src/commands/withdraw.rs:305`, `clients/rust-payment-client/src/policy/mod.rs:165`, `contracts/gateway/RobotMoneyGateway.sol:581`

The withdraw command calls `Preflight::run_gateway_only` with `shares` passed as `amount`, so it checks `maxPerPayment`, `maxPerWindow`, and `agentWindowGross`. The contract checks `maxWithdrawPerPayment`, `maxWithdrawPerWindow`, and `agentWithdrawWindowGross`.

This can refuse valid withdrawals before signing, and it can miss invalid withdrawal policies until on-chain revert.

**Recommendation:** Add a withdrawal-specific preflight path that decodes the withdrawal fields from `agents(agent)` and reads `agentWithdrawWindowGross`.

### 7. MEDIUM — Governance implementation is admin-assigned voting, not token-holder governance

**Files:** `contracts/RouterGovernance.sol:207`, `contracts/RouterGovernance.sol:223`, `docs/prd.md:30`

The PRD says token holders vote on Portfolio Router target weights. The implementation lets `ADMIN_ROLE` assign arbitrary voting power and restricts proposal creation to `ADMIN_ROLE`.

This may be acceptable for an MVP governance mock, but it should not be presented as token-holder governance. It also creates a centralization risk around a single admin changing voting power just before a vote.

**Recommendation:** Label this as admin-weighted MVP governance in docs/UI/API, or integrate an actual token snapshot/voting-power source before public governance claims.

### 8. MEDIUM — Explorer/API position and stats model cannot represent actual per-vault router deposits

**Files:** `services/explorer-indexer/src/indexer.rs:364`, `clients/explorer-api/src/routes.rs:841`, `clients/explorer-api/src/routes.rs:1044`

The indexer stores `AgentDeposit` without a vault column, and the API compensates by using `share_receiver AS vault` for activity/history rows. Router deposits emit `AgentDepositRouted`, but the indexer does not decode that event. Router leg-level `RouterDeposit` events are also not indexed.

The result is misleading multi-vault history: a depositor address can be shown where a vault address is expected, and routed deposits lose their per-leg allocation detail.

**Recommendation:** Add schema columns or child rows for deposit destination/leg vaults, decode `AgentDepositRouted` and `RouterDeposit`, and remove `share_receiver AS vault` from API responses.

### 9. LOW — Faucet chain classifier defaults unknown chain IDs to testnet

**Files:** `clients/dapp/src/lib/chainClassifier.ts:9`, `clients/dapp/src/lib/chainClassifier.ts:42`

The dapp intentionally classifies any unrecognized non-zero chain ID as `testnet`. That keeps faucet UX available on new testnets, but it also means a newly supported mainnet is treated as faucet-eligible until the allowlist is updated.

**Recommendation:** Gate faucet visibility on an explicit testnet/devnet allowlist. If UX needs to support arbitrary local devnets, add an explicit local-dev override rather than treating every unknown chain as safe.

## Test and CI Gaps

- Add ABI drift tests comparing indexer event signatures against Foundry artifact ABIs.
- Add router invariants for zero post-deposit USDC balance and registry-status enforcement.
- Add emergency-mode redemption tests for vault incident response.
- Add withdrawal preflight tests where deposit caps and withdrawal caps intentionally differ.
- Add explorer fixture coverage for `AgentDepositRouted`, `RouterDeposit`, `AgentWithdrawal`, and registry/governance events emitted by the current Solidity sources.

## Positive Notes

- Vault `totalAssets()` now includes idle USDC and the virtual-share offset is non-zero.
- The gateway has a clear depositor-owned agent model and uses CEI plus `nonReentrant`.
- The Rust client has meaningful chain ID, runtime hash, pause, allowance, balance, fee-cap, nonce-lock, and replay-cache checks.
- The repository already has broad CI coverage; the main gap is cross-artifact drift testing, not absence of tests.

## Code And Repo Organization Review

### Organization Summary

The repo is organized around useful product domains: `contracts/`, `clients/`, `services/`, `testing/`, `docs/`, `plugins/`, and shared Rust crates under `crates/`. That is the right basic shape for a protocol MVP because on-chain, client, explorer, and harness code can evolve independently.

The main organizational debt from the feature spike is not naming style; it is source-of-truth sprawl. ABIs, generated docs, test harnesses, devnet setup, and local operation scripts all exist in multiple places without enough machine-checked ownership boundaries.

### O1. MEDIUM — ABI definitions are manually duplicated across contract, Rust, dapp, and indexer surfaces

**Files:** `contracts/gateway/interfaces/IGateway.sol`, `clients/rust-payment-client/abi/*.json`, `clients/dapp/src/lib/abi.ts`, `services/explorer-indexer/src/abi.rs`

The highest-impact organization issue is duplicated protocol interface data. The same event/function surfaces are represented as Solidity, checked-in JSON ABIs, TypeScript constants, and Rust `sol!` declarations. The correctness review already found live drift in the indexer; organizationally, this is a predictable outcome of four manually maintained ABI sources.

**Recommendation:** Make Foundry artifacts the canonical ABI output. Generate Rust bindings and TypeScript ABI modules from `out/**.json`, and add CI that fails when generated files differ from source artifacts.

### O2. MEDIUM — Test harnesses are spread across many roots without a single ownership map

**Files:** `contracts/test/`, `testing/fork-e2e-rust/`, `testing/smoke-test/`, `testing/ethereum-testnet/e2e-rust/`, `testing/ethereum-testnet/typescript-sdk/`, `testing/doctests/`, `clients/dapp/tests/`, `services/explorer-indexer/tests/`

The breadth of tests is good, but the layout is now hard to reason about. There are Foundry tests, Rust fork tests, smoke tests, devnet tests, doctests, dapp unit/e2e tests, TypeScript SDK tests, and service integration tests. A new contributor has to infer which suite owns which product promise.

**Recommendation:** Add `testing/README.md` with a matrix: suite, owner domain, command, CI workflow, required services/secrets, and product promise covered. Link each suite back to `docs/development/ci-suites.md`.

### O3. MEDIUM — Generated documentation lives beside authored documentation without clear freshness metadata

**Files:** `docs/src/contracts/**`, `docs/technical/**`, `docs/architecture.md`

`docs/src/contracts/**` appears to be generated contract reference output, while `docs/technical/**` and top-level docs are authored source-of-truth documents. They are both under `docs/`, and generated pages include contract/test artifacts. That makes doc review noisy and makes it hard to tell whether a stale generated file should be edited by hand.

**Recommendation:** Put generated docs under an explicit `docs/generated/` or add a top-level generated-doc banner plus a CI freshness check. Keep authored ADRs and generated API/reference output visibly separate.

### O4. MEDIUM — Root `Makefile` contains local machine and domain-specific tunnel configuration

**Files:** `Makefile:1`

The root `Makefile` starts with local, uncommitted convenience targets and hard-coded `superfield.co` tunnel hostnames. Root-level commands usually become the public contributor interface; embedding local infrastructure there blurs project workflow with one operator's workstation setup.

**Recommendation:** Move local tunnel targets into `scripts/local/` or `Makefile.local.example`, and keep root `Makefile` targets environment-neutral. Add a `make help` target that lists stable project commands.

### O5. LOW — Package manager ownership is unclear in the dapp

**Files:** `clients/dapp/package.json`, `clients/dapp/bun.lock`, `clients/dapp/pnpm-lock.yaml`

The dapp has both `bun.lock` and `pnpm-lock.yaml`. That may be intentional during transition, but it creates dependency resolution ambiguity for contributors and CI. Different package managers can install subtly different transitive versions.

**Recommendation:** Pick one package manager per JS package and remove or document the other lockfile. If both are intentionally supported, add CI for both and state that in `clients/dapp/README.md`.

### O6. LOW — Runtime artifacts can accumulate at the repo root

**Files:** `.gitignore`, `smoke-test.log`, `smoke-test.log.1`

Logs are ignored, but smoke-test logs currently sit at the repo root. Root-level runtime artifacts make `ls`, review, and ad-hoc tooling noisier, especially when logs are large.

**Recommendation:** Default all smoke/devnet logs to `artifacts/`, `logs/`, or `target/robotmoney/`, all ignored. Keep the repo root for source, manifests, and stable entrypoints.

### O7. LOW — Multiple environment and deployment surfaces need an ownership index

**Files:** `contracts/script/*.sol`, `scripts/devnet/*.sh`, `testing/ethereum-testnet/config/*.yaml`, `clients/dapp/.env.example`, `BOOTSTRAP.md`

Deployment, devnet, fork fixture, and dapp environment setup are spread across scripts, compose files, docs, and bootstrap instructions. Each file is reasonable alone, but there is no single "environment map" that tells an operator which path to use for local devnet, fork e2e, staging-like full stack, or mainnet reads.

**Recommendation:** Add `docs/environments.md` with canonical environment modes, required env vars, startup command, contract address source, data persistence behavior, and teardown command.

### Organization Positive Notes

- Top-level product domains are mostly clean: contracts, clients, services, testing, docs, plugins.
- The Rust workspace centralizes shared crates and test utilities better than ad-hoc per-service builds.
- Many files include canonical doc links, which is useful for preserving intent during fast iteration.
- CI workflow files are well-commented and explain why each suite exists; that pattern should be mirrored in repo-level test documentation.
