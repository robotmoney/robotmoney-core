# Robot Money — Implementation Plan

> Companion to `docs/architecture.md` and `docs/prd.md`. This plan covers the
> full initiative from foundational infrastructure through production readiness.
> As of 2026-05-22, the product layer (Vault registry, Portfolio Router,
> Router-weight governance MVP, Gateway agent withdrawal, multi-vault explorer
> and dapp) is shipped on `dev`. The remaining work is concentrated in: a
> handful of backend/CI gaps, the multi-vault devnet default-adapter switch,
> onboarding docs, and the basket-vault production-path ADRs.
>
> **Relationship to the product.** Robot Money is a multi-vault ERC-4626 yield
> system (stable-yield, protocol-asset, agent-token vaults) with a
> Portfolio Router, a Rust signing daemon (`rmpc`), an on-chain policy gateway,
> a web explorer (API + indexer), a human dapp, and agent skill interfaces for
> OpenCode and OpenClaw. Launch chain is Base.
>
> **What this plan does not cover.** Token launch mechanics, tokenomics, agent
> persona, CFO Feed, multi-chain expansion, agent-token shortlist governance,
> RWA/thematic vault implementation, and MCP server implementation are all
> deferred. See `docs/prd.md` open-questions for their TBD status.

## Goal

Deliver the complete Robot Money product as specified in `docs/prd.md` and
`docs/architecture.md`: a multi-vault ERC-4626 system with a Portfolio Router,
RM-token governance over router weights, multi-vault human dapp, and agent CLI
coverage of all protocol surfaces. The single-vault gateway/agent path is fully
shipped (Phases 1–7 below). The remaining work builds the allocation, governance,
and multi-vault layers that complete the product.

## Non-goals

- Token launch mechanics, tokenomics, Clanker terms, v1/v2 migration
- Agent-token shortlist governance, inclusion proposals, tier system
- CFO Feed product surface
- Multi-chain expansion beyond Base
- RWA or thematic vault implementation
- MCP server (deferred pending OpenClaw/OpenCode integration review)
- Hosted custody or hosted signing

## Phases

### Phase 1 — Secure Agent Deposit Infrastructure
Goal: Deploy the gateway + vault + Rust client with the minimum secure deposit path.

Status: **Complete.** Contracts (gateway, vault, adapters), Rust client (`rmpc` with
all Phase 1 commands), and the e2e test suite are shipped and exercised in CI
(suites 01–07).

### Phase 2 — Fork E2E System Completeness
Goal: Exercise the deployed-style Robot Money flow against a pinned Base mainnet fork.

Status: **Complete.** Fork e2e tests (`testing/fork-e2e-rust/`) run against a
pinned Base fork with per-test snapshot/revert isolation (suite-05 + 06).

### Phase 3 — Vault Feature Completeness (rmpc read surface)
Goal: `rmpc` can answer vault health, agent position, gateway state, and tx
status without any block-explorer API.

Status: **Complete.** All read commands (`get-vault`, `get-balance`, `get-agent`,
`get-gateway`, `get-deposit`, `get-tx`, `get-allowance`, `get-roles`) plus the
shared `Envelope<T>` output contract and `DecimalU256` newtypes are implemented.
`rmpc status` output is normalized into the same envelope shape.

### Phase 4 — Agent-Harness Installation and Skill Loading
Goal: Install and exercise Robot Money inside OpenCode and OpenClaw runtimes.

Status: **Complete.** Skill package, doctests, opencode smoke and headless CI
(suite-11a/11b), and OpenClaw config (suite-12) are present and wired in CI.

### Phase 4.5 — Full-Stack Hosted Devnet
Goal: Single-command stack: Anvil fork, Postgres, explorer-indexer, explorer-API,
dapp, and deployed gateway in the right startup order with health checks.

Status: **Substantially complete** — smoke-test harness and multi-service
orchestration exist. Integration gaps and reliability issues remain (see
Full-stack integration phase below).

### Phase 5 — Simple Web Explorer API and Database
Goal: Lightweight HTTP API + background indexer over a Postgres database for
browsing Robot Money deposit/vault history.

Status: **Complete.** Explorer API (`clients/explorer-api/`) and indexer
(`services/explorer-indexer/`) are implemented with CI coverage (suite-08). See
`docs/technical/explorer-schema-decisions.md` for the schema ADR.

### Phase 6 — Human Dapp
Goal: Human-facing interface for deposits, withdrawals, agent authorization,
policy, rotation, roles, config export, and history.

Status: **Complete.** Full component set is implemented: deposit/withdraw tab,
authorize/revoke/rotate agent, role management, config export, onboarding
wizard, USDC faucet, history pane, calldata preview, pause flow, and admin
flows. Dapp quality and playwright e2e CI (suites 09–10) are wired.

### Phase 7 — OpenClaw E2E Demo
Goal: Autonomous agent loop against a fork: skill load, chain reads, guarded
deposit, refusal handling, tx reporting.

Status: **Complete.** OpenClaw config and CI demo path (suite-12) are complete.

---

## Remaining Work

### Architectural correctness
Goal: Fix the gateway authority model so each depositor is the sole authority
over her own agent.

- [x] Remove admin-gated operator-to-agent binding; depositor sole authority over her own agent — `RobotMoneyGateway.authorizeAgent` sets `agentOwner[agent] = msg.sender` without role gate

### Contract security hardening
Goal: Fix all Solidity-level security findings from the 2026-05-08 code review.

Status: **Complete.** All findings remediated.

- [x] dev-scout: map contract security hardening seams and serialization order — `docs/technical/security-hardening-seams.md`
- [x] CEI fix: gateway `deposit()` reordered and `ReentrancyGuard` applied
- [x] Decimals offset: `RobotMoneyVault._decimalsOffset()` returns 18 (virtual shares)
- [x] MorphoAdapter: `withdraw()` verifies actual delivered USDC via balance-delta
- [x] `totalAssets()`: includes idle vault USDC balance
- [x] `unpause()`: requires `ADMIN_ROLE`
- [x] Fork regression tests — `contracts/test/VaultForkRegressions.t.sol`
- [x] ERC-4626 property-based conformance tests — `contracts/test/RobotMoneyVault4626Conformance.t.sol`
- [x] Test pyramid for timelocked multisig enforcement — `contracts/test/DeployTimelock.t.sol`, dead TimelockPanel removed (#420)

### Backend and dapp hardening
Goal: Fix indexer SQL surface, explorer-API CORS gap, and dapp security gaps.

See also: `docs/technical/dapp-browser-keygen-review.md` (browser-keygen security ADR — in-browser keygen path withdrawn; see §3.1 of `docs/technical/dapp-credential-decisions.md`).

- [ ] dev-scout: map backend hardening seams — partially absorbed into `docs/technical/security-hardening-seams.md`; no dedicated backend scout doc
- [ ] Indexer: restrict or type-guard `db::count()` to prevent dynamic SQL expansion
- [x] Explorer API: CORS via `EXPLORER_API_ALLOW_ORIGINS` env (`clients/explorer-api/src/main.rs`)
- [x] Dapp: verify gateway bytecode hash before admin writes (`clients/dapp/src/lib/gatewayVerifier.ts`)
- [x] Dapp: exported config directly loadable by `rmpc` (`clients/dapp/src/lib/configExport.ts`)

### Full-stack integration
Goal: Complete and harden the smoke-test + devnet stack so the full application
can be started and verified in one command, using real contracts.

Status: **Substantially complete.** The smoke-test stack boots end-to-end on
demand; remaining items are the default-adapter switch (see Multi-vault devnet
below for the canonical N1 item) and a not-yet-confirmed Bun dapp toolchain.

- [ ] Smoke-test: confirm Bun is used for dapp build/runtime (port randomization shipped via `ChainPorts::allocate()`)
- [x] Resolve missing devnet contract addresses, chain ID, RPC endpoint in bootstrap config (`testing/smoke-test/src/lib.rs` Fixture)
- [x] Smoke-test: fork devnet from Base mainnet with genesis-time USDC balance grant (`testing/smoke-test/src/genesis_alloc.rs`)
- [x] Smoke-test: `--full-stack` flag boots dapp, explorer-API, indexer alongside devnet
- [x] Smoke-test: unified structured logs with rotation (`testing/smoke-test/src/logging.rs`)
- [x] Smoke-test: compose collision detection and chain health polling
- [x] Fork e2e: USDC transparent-proxy admin collision resolved via `set_storage_at`
- [x] Dapp: Deposit/Withdraw tab wired to vault ABI with full-stack e2e coverage
- [x] Dapp: testnet/devnet USDC faucet UX (`FaucetTab.tsx`, `FaucetTabView.tsx`)
- [x] Dapp: Playwright E2E against full-stack Geth+Lighthouse devnet
- [x] Dapp: RTL unit tests for refactored admin tabs (`clients/dapp/tests/unit/admin/`)

### Operator and agent safety
Goal: Surface network environment in the CLI, standardize logging, upload CI
artifacts, and close remaining CI wiring gaps.

- [x] `rmpc`: network environment surfaced in CLI logs (`commands/status.rs` via `NetworkEnv::from_chain_id()`)
- [x] Logging: standardized Rust logging facade (`clients/rust-payment-client/src/logging.rs`)
- [x] CI: e2e artifacts uploaded (`suite-10-dapp-e2e.yml`)
- [x] CI: opencode-refusal job wired to `testing/doctests` (`suite-11b-opencode-headless.yml`)
- [ ] CI: slim suite-05 by migrating duplicate tests into suite-06

### Release infrastructure
Goal: Ship `rmpc` binary releases, a dapp Docker image, and reliable CI
triggers so operators can install from published artifacts.

- [x] CI: `rmpc` binary release workflow (`.github/workflows/release-rmpc.yml`)
- [x] CI: dapp Docker image published to GHCR (`.github/workflows/release-dapp.yml`)
- [ ] CI: run all suites unconditionally on push to `dev` — suite-01-02 and others still gated by `paths:` filters
- [x] CI: `workflow_dispatch` inputs (tag, commit, dry_run) on release workflows
- [ ] Remove deprecated Anvil demo suite (`demo.sh` + suite-15) — confirm whether suite-15 (regime-classifier) is the same artifact slated for removal
- [ ] Audit suite-05 (Anvil mainnet-fork) for necessity vs. suite-06 duplication

### Docs and onboarding
Goal: Publish security review, streamline agent-vendor onboarding, document
devnet configuration, and offer a tunnel-based hosted devnet demo path.

- [ ] Publish 2026-05-09 security review document
- [x] Create `BOOTSTRAP.md` and simplify `README` to a single agent-onboarding pointer
- [ ] Add agent-vendor bootstrap prompts (OpenCode, OpenClaw, Claude Code)
- [ ] Tunnel hosted devnet demo + wallet-routed dapp reads

---

## Product Layer (new phases — multi-vault, router, governance)

The single-vault agent-deposit path is complete. The following phases build
the product surfaces described in `docs/architecture.md` that do not yet exist
in the codebase: the on-chain vault registry, Portfolio Router, RM-token
governance, multi-vault CLI commands, gateway agent withdrawal, multi-vault
explorer data model, and the multi-vault dapp. Basket vaults (protocol-asset
and agent-token) require separate ADRs before production integration and are
scouted in the final phase.

### Phase: Vault registry
Status: **Complete.**

- [x] dev-scout: vault registry seams — `docs/technical/security-hardening-seams.md`
- [x] `VaultRegistry.sol` with `registerVault`, `setVaultStatus`, `getVault`, `listVaults`, and `VaultRegistered`/`VaultStatusChanged` events
- [x] Deploy script — `contracts/script/DeployVaultRegistry.s.sol`
- [x] Explorer indexer ingests registry events; `vaults` table extended
- [x] Explorer API `GET /v1/vaults`
- [x] `rmpc get-vaults`
- [x] `rmpc get-vault <address>`
- [x] Fork e2e — `testing/fork-e2e-rust/tests/registry.rs`

### Phase: Portfolio Router contract
Status: **Complete.**

- [x] dev-scout — `docs/technical/portfolio-router-decisions.md`
- [x] `PortfolioRouter.sol` — weight-based USDC split, all-or-revert, caps, `RouterDeposit` event
- [x] `previewDeposit(amount)` preview surface with per-leg detail
- [x] Gateway extended to allow router destination
- [x] Deploy script — `contracts/script/DeployPortfolioRouter.s.sol`
- [x] Fork e2e — `testing/fork-e2e-rust/tests/router.rs`

### Phase: Router-weight governance
Status: **Complete (MVP).** Per PR #391, `RouterGovernance` is currently an
admin-weighted MVP mock; full RM-token-weighted voting is deferred until token
launch (out of scope per Non-goals).

- [x] dev-scout — `docs/technical/governance-decisions.md`
- [x] `RouterGovernance.sol` proposal/vote/quorum/execution-delay (admin-weighted MVP)
- [x] Read surface — `activeProposal()`, `voteTallies()`, `currentWeights()`
- [x] Explorer indexer ingests governance events; `governance_proposals` and `governance_votes` tables
- [x] Explorer API `GET /v1/router/weights`, `GET /v1/governance/proposals`
- [x] `rmpc get-router`
- [x] `rmpc get-governance`
- [x] Fork e2e — `testing/fork-e2e-rust/tests/governance.rs`

### Phase: Gateway agent withdrawal
Status: **Complete.**

- [x] dev-scout — `docs/technical/gateway-withdrawal-decisions.md`
- [x] `RobotMoneyGateway.withdraw(orderId, shares, sourceVault, deadline, idempotencyKey)`
- [x] `AgentPolicy` extended with `assetRecipient`, `maxWithdrawPerPayment`, `maxWithdrawPerWindow`, `allowedSourceVaults`
- [x] `authorizeAgent` / `setPolicy` surface withdrawal fields; dapp config export updated
- [x] `rmpc withdraw` command
- [x] Fork e2e — `testing/fork-e2e-rust/tests/withdrawal.rs`

### Phase: Multi-vault explorer
Status: **Substantially complete.**

- [x] Schema migration: per-vault `vault_snapshots`, `router_weight_snapshots`, `governance_proposals`, `governance_votes`
- [x] Indexer polls all registered vaults; ingests router and governance events
- [x] Explorer API `GET /v1/vaults/:address`
- [x] Explorer API `GET /v1/router/state`
- [ ] Explorer API `GET /v1/stats` — aggregate TVL / depositor count / global activity feed not yet exposed
- [x] Explorer API `GET /v1/accounts/:address/positions`
- [x] Explorer API `GET /v1/accounts/:address/history`
- [x] Fork e2e — multi-vault indexer + API round-trip

### Phase: Multi-vault dapp
Status: **Substantially complete.** All three layers (protocol / account /
action) are wired with the components named in `docs/architecture.md` §5.3.

- [x] Protocol layer — vault registry view, vault detail view, router view, protocol stats (`VaultList.tsx`, `VaultCards.tsx`, `RouterView.tsx`)
- [x] Account layer — portfolio positions, transaction history, agent policies (`AccountLayerView.tsx`)
- [x] Action layer — vault-selector deposit, withdrawal, governance voting (`DestinationSelector.tsx`, `GovernancePanel.tsx`)
- [x] Playwright multi-vault E2E

### Phase: Multi-vault devnet
Goal: Boot the smoke-test devnet with real adapters and all production-ready
vaults registered. The PassthroughAdapter remains the default in smoke-test
until N1 lands; ProtocolAssetVault and AgentTokenVault remain blocked on
basket-vault ADRs.

- [ ] `Deploy.s.sol`: make real AaveV3 / Compound V3 / Morpho adapters the default smoke-test path; remove PassthroughAdapter from the smoke-test deploy
- [x] Smoke-test `Fixture` surfaces all adapter addresses
- [x] `RobotMoneyVault` registered in `VaultRegistry`; initial router weights set
- [x] Fork e2e: deposit/withdrawal round-trip against real adapter stack (Aave/Compound/Morpho)
- [ ] Deploy scripts: add `ProtocolAssetVault` + `AgentTokenVault` once basket ADRs resolved
- [ ] Fixture surfaces basket vault addresses once devnet-deployed
- [ ] Fork e2e: multi-vault round-trip including basket vaults

### Phase: Demo seeding
Goal: Wire a presentable end-to-end demo on top of the smoke-test devnet:
seeded vaults with simulated depositors, multi-vault router weights, wallet
balance display, RM token bundled into the dapp env, and a Base ETH gas
faucet drip. Tracked by issue #472 (scout) and the downstream feature
issues below.

- [x] dev-scout: demo-seeding seam map — `docs/technical/demo-seeding-seams.md` (issue #472)
- [ ] dapp: show wallet balances for USDC, ETH, RM, and vault receipts on the main page (issue #463)
- [ ] demo: seed all three vaults, simulated depositors, and multi-vault router weights (issue #465)
- [ ] dapp: wire RM token address into the dapp bundle + add Base ETH gas faucet drip (issue #466)

### Phase: Basket vault production path
Goal: Resolve open ADRs blocking basket-vault router eligibility.

- [x] dev-scout audit + gap report — `docs/technical/basket-vault-gap-report.md`
- [ ] TWAP oracle in both basket vaults (BasketVault TWAP hardening shipped in #459; confirm coverage across ProtocolAssetVault + AgentTokenVault)
- [ ] Rebalancing model ADR + `rebalance()` implementation
- [ ] Agent-token shortlist governance — mechanism per `docs/development/open-questions.md` §1.3
- [ ] Router eligibility: register both basket vaults once ADRs resolved + audited
