# Robot Money — Implementation Plan

> Companion to `docs/architecture.md` and `docs/prd.md`. This plan covers the
> full initiative from foundational infrastructure through production readiness.
> As of May 2026, the application and infrastructure are ~90% complete; the
> remaining work is concentrated in security hardening, release infrastructure,
> full-stack integration, and onboarding documentation.
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
over her own agent. The current code incorrectly gates agent binding on an admin
role, violating the depositor-sole-authority invariant specified throughout the
product and security docs.

- [ ] Remove admin-gated operator-to-agent binding; depositor sole authority over her own agent

### Contract security hardening
Goal: Fix all Solidity-level security findings from the 2026-05-08 code review.
Three findings touch vault storage and must be serialized; a dev-scout maps the
safe edit order before any implementation begins.

- [ ] dev-scout: map contract security hardening seams and serialization order
- [ ] CEI fix: reorder effects before interactions in gateway `deposit()` and add `ReentrancyGuard`
- [ ] Decimals offset: choose safe ERC-4626 decimals offset to prevent first-depositor inflation
- [ ] MorphoAdapter: verify actual withdrawn amount in `withdraw()`
- [ ] `totalAssets()`: include idle vault USDC balance in accounting
- [ ] `unpause()`: require `ADMIN_ROLE` not `EMERGENCY_ROLE` — mirror gateway asymmetry
- [ ] Fork regression tests for vault accounting attack paths
- [ ] ERC-4626 property-based conformance tests for all vault contracts

### Backend and dapp hardening
Goal: Fix indexer SQL injection surface, explorer-API CORS gap, and two dapp
security gaps. Contract security findings and backend fixes are independent and
can run concurrently after their respective scout gates.

See also: `docs/technical/dapp-browser-keygen-review.md` (browser-keygen security ADR — in-browser keygen path withdrawn; see §3.1 of `docs/technical/dapp-credential-decisions.md`).

- [ ] dev-scout: map backend hardening seams
- [ ] Indexer: restrict or type-guard `db::count()` to prevent dynamic SQL expansion
- [ ] Explorer API: add CORS configuration for cross-origin dapp access
- [ ] Dapp: verify gateway bytecode hash before admin writes
- [ ] Dapp: fix exported config so it is directly loadable by `rmpc`

### Full-stack integration
Goal: Complete and harden the smoke-test + devnet stack so the full application
can be started and verified in one command, using real contracts.

- [ ] Wire `RobotMoneyVault` + `PassthroughAdapter` into smoke-test devnet (replace `MockVault`)
- [ ] Resolve missing devnet contract addresses, chain ID, and RPC endpoint in bootstrap config
- [ ] Smoke-test: randomize ports and use Bun for dapp build/runtime
- [ ] Smoke-test: fork devnet from Base mainnet with genesis-time USDC balance grant
- [ ] Smoke-test: `--full-stack` flag to boot dapp, explorer-API, and indexer alongside devnet
- [ ] Smoke-test: unified structured logs with rotation for all spawned services
- [ ] Smoke-test: detect compose collision and poll chain health during startup
- [ ] Fork e2e: resolve USDC transparent-proxy admin collision so `rmpc` tests pass without spoofing `from`
- [ ] Dapp: wire Deposit/Withdraw tab to vault ABI with full-stack e2e coverage
- [ ] Dapp: testnet/devnet USDC faucet UX (onboarding seed + admin faucet tab)
- [ ] Dapp: Playwright E2E against full-stack Geth+Lighthouse devnet
- [ ] Dapp: RTL unit tests for refactored admin tabs

### Operator and agent safety
Goal: Surface network environment in the CLI, standardize logging, upload CI
artifacts, and close remaining CI wiring gaps.

- [ ] `rmpc`: surface network environment in CLI logs and agent skill feedback
- [ ] Logging: standardize Rust logging facade across the workspace
- [ ] CI: always upload e2e artifacts as run evidence (screenshots + agent logs)
- [ ] CI: wire opencode-refusal job to existing `testing/doctests` test
- [ ] CI: slim suite-05 by migrating duplicate tests into suite-06

### Release infrastructure
Goal: Ship `rmpc` binary releases, a dapp Docker image, and reliable CI
triggers so operators can install from published artifacts.

- [ ] CI: `rmpc` binary release workflow
- [ ] CI: publish dapp Docker image to GHCR with operator `docker-compose`
- [ ] CI: run all suites unconditionally on push to `dev`
- [ ] CI: `workflow_dispatch` inputs (tag + commit hash) on release workflows
- [ ] Remove deprecated Anvil demo suite (`demo.sh` + suite-15)
- [ ] Audit suite-05 (Anvil mainnet-fork) for necessity vs. suite-06 duplication

### Docs and onboarding
Goal: Publish security review, streamline agent-vendor onboarding, document
devnet configuration, and offer a tunnel-based hosted devnet demo path.

- [ ] Publish 2026-05-09 security review document
- [ ] Create `BOOTSTRAP.md` and simplify `README` to a single agent-onboarding pointer
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
Goal: Deploy an on-chain vault registry so all downstream surfaces — Portfolio
Router, dapp protocol layer, `rmpc`, and explorer indexer — share a single
authoritative list of active vaults with their mandates, statuses, caps, risk
labels, fee schedules, and receipt token addresses. The registry emits events
the indexer can track.

- [ ] dev-scout: map vault registry contract seams, event schema, and indexer integration points
- [ ] `VaultRegistry.sol` — on-chain registry with `registerVault`, `setVaultStatus`, `getVault`, and `listVaults` read surface; emits `VaultRegistered` and `VaultStatusChanged` events
- [ ] Deploy script: populate registry with `RobotMoneyVault` on devnet and Base fork
- [ ] Explorer indexer: ingest `VaultRegistered` / `VaultStatusChanged` events; extend `vaults` table
- [ ] Explorer API: `GET /v1/vaults` — list all registered vaults with indexed TVL, status, fee, and receipt token
- [ ] `rmpc get-vaults` — protocol-scope read: all registered vaults, name, risk label, status, TVL, caps, exit fee, receipt token
- [ ] `rmpc get-vault <address>` — single-vault detail: adapter breakdown, rebalance state, historical TVL from explorer
- [ ] Fork e2e: registry register → list → status-change round-trip

### Phase: Portfolio Router contract
Goal: Ship the Portfolio Router — the outer allocation contract that accepts
USDC and splits deposits across active vaults by RM-governed weights, with
all-or-revert semantics and a preview surface before signing. This is the
defining product differentiator and a prerequisite for multi-vault deposits,
governance execution, and the full dapp action layer.

- [ ] dev-scout: map Portfolio Router contract seams, preview call signatures, cap enforcement across legs, and weight execution path
- [ ] `PortfolioRouter.sol` — accepts USDC, reads active vault list from registry, splits deposit by weight bps; all-or-revert; enforces router cap and per-vault cap; emits `RouterDeposit` with per-leg detail
- [ ] `PortfolioRouter.sol` preview surface — `previewDeposit(amount)` returns per-vault estimated receipts, fees, weights, and `unavailable` flag per leg
- [ ] Gateway: extend allowed destinations to include the Portfolio Router; enforce the same deposit policy checks for router-routed agent deposits
- [ ] Deploy script: deploy router with initial weights pointing at `RobotMoneyVault`; register with gateway as an allowed destination
- [ ] Fork e2e: router deposit happy path, unavailable-leg revert, cap enforcement, and per-leg event assertions

### Phase: Router-weight governance
Goal: Give RM-token holders on-chain control over Portfolio Router target
weights. Ship a narrow governance contract: proposal creation, voting, quorum
and cadence enforcement, execution delay, and weight application. Keep scope
minimal — this module controls router weights only and cannot govern vault
internals, agent permissions, or protocol admin operations.

- [ ] dev-scout: map governance contract design, quorum/cadence/execution parameters, and integration with Portfolio Router weight update
- [ ] `RouterGovernance.sol` — weight-vote contract: propose new weight bps vector, accept RM-token votes weighted by balance, enforce quorum threshold and voting cadence, apply weights to router after execution delay; emits `ProposalCreated`, `VoteCast`, `ProposalExecuted`, `WeightsApplied`
- [ ] `RouterGovernance.sol` read surface — `activeProposal()`, `voteTallies()`, `currentWeights()`, `cadenceParams()` for `rmpc` and dapp reads
- [ ] Explorer indexer: ingest governance events; add `governance_proposals` and `governance_votes` tables
- [ ] Explorer API: `GET /v1/router/weights`, `GET /v1/governance/proposals`, `GET /v1/governance/proposals/:id` with vote tallies and execution state
- [ ] `rmpc get-router` — Portfolio Router state: active vault addresses, current weight bps per vault, pending proposal if any, router cap
- [ ] `rmpc get-governance` — governance state: active proposal, vote tallies, cadence, quorum threshold, execution delay, last applied weights
- [ ] Fork e2e: propose → vote past quorum → execute → assert router weights updated

### Phase: Gateway agent withdrawal
Goal: Close the agent-withdrawal gap. The gateway currently gates only agent
deposits; the architecture specifies the same permission boundary for agent
withdrawals. Add a `withdraw` verb to the gateway contract and a corresponding
`rmpc withdraw` command so agents can redeem vault receipts under a
depositor-owned policy without being able to redirect proceeds.

- [ ] dev-scout: map gateway withdrawal seams, receipt-allowance model, policy field additions (asset recipient, allowed source vault), and rmpc signing path
- [ ] `RobotMoneyGateway.sol`: add `withdraw(bytes32 orderId, uint256 shares, address sourceVault, uint64 deadline, bytes32 idempotencyKey)` — verifies receipt owner, receipt allowance, receipt balance, allowed source, max amount, min net assets out, policy-configured asset recipient, pause, and window cap; calls vault `redeem`; sends USDC to configured recipient only; emits `AgentWithdrawal`
- [ ] `AgentPolicy`: extend with `assetRecipient` (where USDC proceeds go), `maxWithdrawPerPayment`, `maxWithdrawPerWindow`, and `allowedSourceVaults`
- [ ] `authorizeAgent` / `setPolicy`: surface new withdrawal fields; dapp config export updated
- [ ] `rmpc withdraw` command — preflight reads (receipt balance, allowance, vault state, policy, cap usage), build and sign `gateway.withdraw` calldata, broadcast, emit result JSON
- [ ] Fork e2e: agent withdrawal happy path, recipient-redirect blocked, receipt-allowance check, window cap

### Phase: Multi-vault explorer
Goal: Extend the explorer indexer schema and API to cover all registered
vaults, Portfolio Router state, governance events, and account positions across
vaults. The dapp protocol and account layers depend on this data.

- [ ] dev-scout: map schema migration seams across `vault_snapshots`, `agent_deposits`, and new tables; confirm no single-vault assumptions in indexer poll loop
- [ ] Schema migration: generalize `vault_snapshots` to be keyed by `(chain_id, vault_address)`; add `router_weight_snapshots`, `governance_proposals`, `governance_votes` tables; add `account_positions` materialized or query view
- [ ] Indexer: poll all registered vaults from the registry; index `RouterDeposit` and `RouterWithdrawal` events alongside direct vault events; index governance proposal and vote events
- [ ] Explorer API: `GET /v1/vaults/:address` — single vault with adapter allocation history, TVL over time, and event log
- [ ] Explorer API: `GET /v1/router/state` — current weights, weight change history, governance proposal log
- [ ] Explorer API: `GET /v1/stats` — aggregate TVL across all active vaults, unique depositor count, global activity feed
- [ ] Explorer API: `GET /v1/accounts/:address/positions` — receipt token balances and USDC values per vault for an address
- [ ] Explorer API: `GET /v1/accounts/:address/history` — chronological event log across all vaults for an address
- [ ] Fork e2e: multi-vault indexer ingestion and API query round-trip

### Phase: Multi-vault dapp
Goal: Upgrade the dapp from a single-vault tool to the full three-layer
product surface specified in `docs/architecture.md` §5.3: a protocol layer
(no wallet required), an account layer (watched address or connected wallet),
and an action layer with vault-selector deposits, Portfolio Router deposits,
multi-vault withdrawals, and governance voting.

- [ ] dev-scout: map dapp component seams — identify shared state (vault registry reads, router weights, governance state), hot files (App.tsx, abi.ts), and the correct split between live-chain reads (safety-critical) and explorer reads (display only)
- [ ] Protocol layer — vault registry view: list all registered vaults with name, risk label, TVL, APY estimate, exit fee, deposit cap headroom, and status; derived from chain reads and explorer API
- [ ] Protocol layer — vault detail view: single-vault breakdown with adapter allocations, TVL, rebalance state, fee schedule, caps, receipt token, and historical charts
- [ ] Protocol layer — Portfolio Router view: active vaults, current target weights, pending governance proposal, historical weight changes
- [ ] Protocol layer — protocol stats: total TVL across active vaults, unique depositor count, recent global activity feed
- [ ] Account layer — portfolio position view: receipt token balances across all registered vaults, USDC value of each position using live share price, composite portfolio total; works for watched address (no wallet required) and connected wallet
- [ ] Account layer — transaction history: chronological deposit, withdrawal, fee, and governance vote events sourced from explorer indexer
- [ ] Account layer — agent policies panel: all active policies the address owns with allowed destinations, caps, window usage, receivers, and expiry
- [ ] Action layer — vault-selector deposit: pick direct vault or Portfolio Router path, enter amount, preview (destination weights, estimated receipts, fees, net amount, unavailable legs), sign
- [ ] Action layer — withdrawal: pick position, enter amount or shares, preview (source vault or router path, estimated USDC, fee, net amount), sign
- [ ] Action layer — governance voting: review active weight proposal, cast vote, view execution state
- [ ] Dapp Playwright E2E: multi-vault deposit and withdrawal flows against full-stack devnet with router and governance contracts deployed

### Phase: Basket vault production path
Goal: Scout the production requirements for the protocol-asset vault
(wETH/cbBTC/wSOL) and agent-token vault so they can eventually be onboarded
into the Portfolio Router. Both are prototype contracts today. Neither may
enter the router until synchronous redemption is proven, TWAP pricing
replaces slot0, a rebalancing model is specified, and the agent-token
shortlist governance mechanism is resolved. This phase is scout-only; no
production deployment without a resolved ADR for each open question.

- [ ] dev-scout: audit `ProtocolAssetVault.sol` and `AgentTokenVault.sol` against the router-eligibility checklist (synchronous redemption guarantee, TWAP oracle, rebalancing model, slippage bounds, shortlist governance); produce a gap report and draft ADR for each vault
- [ ] TWAP oracle: replace slot0 pricing in both basket vaults with a time-weighted average price source; assert manipulation resistance under the scout's recommended window
- [ ] Rebalancing model: specify and implement `rebalance()` admin function with cost disclosure, equal-weight target, and slippage guard; write ADR resolving trigger authority, cost bearer, and displacement rules
- [ ] Agent-token shortlist governance: resolve shortlist ownership (admin-curated vs. RM-token inclusion vote vs. bribery mechanism) per `docs/prd.md` §1.3; implement the resolved mechanism
- [ ] Router eligibility: register both vaults with the vault registry and Portfolio Router once all ADRs are resolved and audited
