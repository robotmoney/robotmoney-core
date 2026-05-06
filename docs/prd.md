# Robot Money — Product Requirements

> Scope: this PRD describes the **Robot Money product in full** — the on-chain vault and adapters, the governance token and voting system, the web application, the agent-facing CLI and skill plugin, the wallet-onboarding flow, and the allocation-transparency surfaces. It is atemporal: it specifies what the product *is*, not the order in which pieces are built or which surface ships first. Implementation status, deployment artifacts (addresses, version numbers, phase labels) live in `docs/project-roadmap.md` and `CHANGELOG.md`.

## 1. Product

Robot Money is an autonomous treasury protocol for the agent economy. Idle USDC held by AI agents, autonomous machines, or human depositors is pooled in an ERC-4626 vault and allocated across three buckets: a stable-yield base, a diversified set of agent-economy tokens, and a set of revenue-generating tokens. Allocation is determined by holders of the protocol's governance token. Depositors receive a single share token (`rmUSDC`) whose NAV grows with the portfolio's performance.

A single deposit gives a holder pro-rata exposure to all three buckets without per-protocol onboarding. A single withdrawal returns NAV-equivalent USDC, net of exit fee, in one synchronous transaction.

The product surface spans:
- An ERC-4626 vault and per-protocol adapters that custody USDC and route across stable-yield venues.
- A governance token (`$ROBOTMONEY`) and voting system that sets bucket weights and per-bucket constituents.
- A web application for human depositors and observers (dashboards, allocation, performance, governance).
- An agent-facing CLI (`@robotmoney/cli`) and Claude-format skill plugin (`robotmoney-cli`) that expose the protocol programmatically to autonomous software.
- A wallet-onboarding flow built on Open Wallet Standard for agents and users without an existing key.
- Allocation-transparency surfaces that report both vault-resident assets and externally delegated strategies in real time.

## 2. Users

**Autonomous depositors.** AI agents, machines, and any non-human software actor holding USDC that wants diversified yield without bespoke DeFi integration. Includes Claude/Cursor/Codex sessions, trading bots, IoT and peaq-network machines, and any MCP-compatible agent.

**Human depositors.** Individuals seeking diversified, actively governed exposure to stable yield plus the agent-token economy via a single share token.

**LLM intermediaries.** Models acting on behalf of a user who want a conversational interface to read, deposit, or withdraw.

**Token holders.** Holders of `$ROBOTMONEY` who govern bucket composition and weights and who benefit from buyback-and-burn supply reduction funded by protocol revenue.

**Integrators.** Developers embedding Robot Money into their own agent runtimes who consume unsigned calldata and sign with external infrastructure (Safe, Fireblocks, hardware wallets, smart-account stacks).

## 3. Goals

1. **One transfer, diversified exposure.** A single USDC deposit yields pro-rata exposure across stable yield, agent-economy tokens, and revenue-generating tokens. No manual rebalancing, no per-protocol approval chains.
2. **Two-audience parity.** Humans interact via the web app; agents interact via the CLI/skill. Both surfaces expose the same primitives — deposit, withdraw, observe, govern — with audience-appropriate ergonomics.
3. **LLM-legibility.** Programmatic surfaces emit stable, documented, decoded JSON. Errors surface by name. An LLM can act on tool output without screen-scraping.
4. **No-config defaults.** First-time use requires no RPC selection, no slippage tuning, no manual approval bookkeeping.
5. **Custody-neutral.** The protocol custodies only what the vault contract holds. No product surface custodies private keys; signing happens in user-controlled wallets.
6. **Honest failure surfaces.** Every state-changing flow simulates before broadcast. Partial-failure messages distinguish "nothing was broadcast" from "some legs landed before failure." Caps, pauses, and shutdowns surface as named errors.
7. **Governance-driven composition.** Bucket weights and bucket-B/C constituents are voted on published cadences. The protocol does not hardcode a permanent universe of holdings.

## 4. User stories

Three end-to-end narratives, each covering one column of the user matrix in §2: an autonomous-agent operator with a fiat-to-stablecoin ramp, a machine-economy operator with no fiat path, and a human delegating to an LLM. Each story specifies revenue origination, the path from USD (or equivalent) to USDC on Base, pre-treasury custody, the commands the agent invokes, key management and guardrails, the API/RPC surface called, the success signal, and ongoing performance tracking. These stories are illustrative; they are the source of the functional and non-functional requirements in §5 and §6.

### 4.1 Zero-human SaaS company — autonomous-agent operator with a fiat ramp

**Context.** A micro-SaaS sells API access to other agents. The company has no employees; its operations run on **Moltbook** — an autonomous-company harness running headlessly on a single Hetzner VPS. Robot Money is wired in once: `npm install -g @robotmoney/cli` makes the binary reachable, the `robotmoney-cli` plugin is loaded into Moltbook's skill registry so the agent knows when each command applies, and a sweep is scheduled via Moltbook's built-in cron primitive. Revenue is invoiced in USD via the Stripe Agent SDK.

**USD origination.** Customer charges land in a Stripe balance. Daily Stripe payouts settle to a Bridge.xyz USD virtual account. (Beam, Mercury, or Stripe stablecoin payouts are equivalent paths.)

**USD → USDC.** Bridge auto-converts the USD balance to Base USDC nightly and pushes it to the company's Base hot wallet.

**Pre-treasury USDC management.** USDC accumulates in the hot wallet. The wallet retains a fixed working reserve (e.g. $1,000 for vendor and infra payments); the surplus above the reserve is treasury-sweep eligible.

**Key management & guardrails.** Keys live in an OWS keystore on the VPS. The harness never reads key material — it speaks to OWS over local IPC. OWS policy:
- Per-tx cap: $5,000.
- Per-day cap: $10,000 outbound.
- Contract allowlist: Robot Money vault, USDC, Permit2, UniversalRouter.
- Transactions above $2,500 require a co-signature from the founder's hardware wallet via OWS's multisig flow.

**Trigger.** A cron skill in the harness fires daily at 02:00 UTC.

**Commands.**

```bash
# 1. Read pre-sweep state.
npx @robotmoney/cli get-balance --user-address $WALLET --chain base
# → { usdcBalance, ethBalance, rmUsdcBalance, navUsdc }
# NOTE: usdcBalance and ethBalance are not yet in the output — see issue-get-balance-wallet-context.md

# 2. If usdcBalance > reserve + minDeposit, sweep the surplus.
npx @robotmoney/cli execute-deposit \
  --wallet ops \
  --amount $((usdcBalance - reserve)) \
  --chain base
```

**API/RPC surface.** The CLI dispatches over viem's `fallback()` transport to a built-in Base RPC pool (multiple free endpoints with rate-limit retry). On-chain calls: `USDC.allowance`, `USDC.approve`, `RobotMoneyVault.deposit`, `Permit2.approve`, `UniversalRouter.execute`. No third-party API is in the deposit path.

**Success signal.** `execute-deposit` exits 0 and emits JSON with `transactions[].hash` plus a `receipt.status === "success"` per leg, along with the resulting `rmUSDC` share balance. The harness parses the JSON, writes the hashes to its Postgres ops log, and posts a one-line Slack notification. Failure modes (cap full, paused, insufficient gas, slippage exceeded) surface as named errors with no on-chain side effects when they fail pre-broadcast.

**Performance tracking.** A weekly skill invokes `get-balance`, `get-vault`, and `get-allocation`. The harness stores a daily NAV snapshot (`shares × sharePrice` net of exit fee) and computes 7- and 30-day rolling returns against the cumulative cost basis. Anomalies — NAV drop > 1%, vault paused, cap full, governance proposal that materially changes weights — escalate to a founder-only Slack channel.

### 4.2 Machine-economy operator — solar charger settling x402 micropayments

**Context.** A solar inverter or EV charger sells kWh to passing devices over x402. The agent loop runs in **OpenClaw** on edge compute (Raspberry Pi-class) co-located with the device. OpenClaw connects to Robot Money via MCP — `npx @robotmoney/cli mcp` runs as a long-lived server on the device, so the constrained runtime never has to shell out — and the skill's reference files (`read.md`, `write.md`, `basket.md`) are registered as tool descriptions in OpenClaw's prompt.

**USD origination.** None. There is no fiat leg. Customers pay directly in USDC.

**USD → USDC.** N/A. The device's payout address is its own Base hot wallet; settlement is direct in USDC on Base.

**Pre-treasury USDC management.** USDC trickles in per kWh sale. The device retains a small working float (e.g. $5) for refunds and retries, sweeping the surplus.

**Key management & guardrails.** OWS-lite on the device with hardware-backed key storage (TPM or Secure Element). Policy:
- Per-tx cap: $100.
- Per-day cap: $500.
- Contract allowlist: Robot Money vault only — no DEX, no arbitrary `transfer`. Even a fully compromised device cannot move funds elsewhere; it can only send them to the vault.
- Withdraw authority is held by a separate operator key that lives off the device.

**Trigger.** Balance threshold: sweep when USDC ≥ $25. Below that, gas amortization isn't worth the round trip.

**Commands.**

```bash
# Vault-only — this device has no view on agent tokens, only on yield.
npx @robotmoney/cli execute-deposit \
  --wallet device \
  --amount $balance \
  --no-basket \
  --json
```

**API/RPC surface.** Same RPC fallback pool as §4.1. With `--no-basket`, only `USDC.approve` and `RobotMoneyVault.deposit` are called — Permit2 and UniversalRouter are bypassed.

**Success signal.** CLI exits 0 with JSON; the device writes the tx hash to a local SQLite ledger and beacons a heartbeat (`{ deviceId, txHash, sharesReceived, blockNumber, timestamp }`) over MQTT to the operator's monitoring stack.

**Performance tracking.** A weekly `get-balance` + `get-vault` read populates a local Prometheus exporter. The operator's Grafana board aggregates fleet-wide NAV, share count, 7-day blended APY, and time-since-last-sweep per device. A device that hasn't swept in N days alerts the operator regardless of fault diagnosis.

### 4.3 Builder delegating to Claude — LLM intermediary with external signer

**Context.** A solo builder is paid in USDC on Base for freelance agent work via Skyfire. They run **Claude Code** locally with the `robotmoney-cli` plugin installed from the marketplace (`/plugin marketplace add robotmoney/robotmoney-skills` then `/plugin install robotmoney-cli@robotmoney`) so Claude has the skill in scope automatically. They ask: *"Park my idle USDC in the Robot Money treasury and check what it's doing each Monday."*

**USD origination.** Skyfire payouts in USDC on Base. No fiat involved.

**USD → USDC.** N/A — already on Base.

**Pre-treasury USDC management.** Idle USDC sits in the builder's Coinbase Smart Wallet. The builder does not trust an LLM with private keys.

**Key management & guardrails.** Claude **never holds keys**. It uses the `prepare-*` path: build the unsigned tx sequence, hand it to the human, the human signs in their wallet. The same flow applies to any external signer (Safe, Fireblocks, hardware, Coinbase Smart Wallet).

**Commands.**

```bash
# 1. Stage the deposit.
npx @robotmoney/cli prepare-deposit \
  --user-address $BUILDER_ADDR \
  --amount 500 \
  --receiver $BUILDER_ADDR \
  --json
# → operation.transactions[] (to, value, data, gasLimit) + simulation results
```

Claude pretty-prints the per-tx summary and the simulation outcome. The builder reviews and signs each tx in their wallet. Claude then polls `get-balance` until the `rmUSDC` share count increases by the expected amount.

**API/RPC surface.** During staging: the RPC fallback pool, vault read methods (`previewDeposit`, `convertToShares`, `tvlCap`, `perDepositCap`, `paused`, `shutdown`), and simulation via `eth_call` with `stateOverride` to inject a synthetic USDC allowance so the gas estimate reflects post-approval reality. During signing: nothing — the builder's wallet broadcasts. After broadcast: `get-balance` and an `eth_getTransactionReceipt` lookup keyed off the hashes the wallet UI returns.

**Success signal.** Claude observes the `rmUSDC` balance delta plus a `receipt.status === "success"` per leg. Result is a one-line confirmation in the chat with vault NAV and confirmed share count.

**Performance tracking.** A scheduled skill fires every Monday morning via Claude Code's `/schedule` primitive (cron-backed routine). It runs `get-balance`, `get-apy`, `get-vault`, and `get-allocation`, diffs against the previous week's snapshot stored in the project's memory file, and reports: weekly $ change, weekly realized APY, current bucket weights, and any governance proposals open for vote that the builder may want to weigh in on.

## 5. Functional requirements

### 5.1 Vault

- ERC-4626 tokenized vault denominated in USDC, share token `rmUSDC` at 6 decimals.
- Full ERC-4626 surface: `deposit`, `mint`, `withdraw`, `redeem`, `convertTo*`, `preview*`, `max*`. `previewWithdraw` and `previewRedeem` return amounts **net of the exit fee**; callers do not double-subtract.
- Adapter introspection: callers can enumerate active adapters and read per-adapter balances, target weights, and per-adapter caps.
- Two emergency switches:
  - **`paused`** — reversible operational brake (OZ Pausable).
  - **`shutdown`** — permanent, terminal kill that disables deposits while preserving withdrawals.
- Governance-settable TVL cap and per-deposit cap, enforced atomically on `deposit`.
- Synchronous redemption: no cooldown, no two-step claim, no unbonding window. Both `withdraw(assets)` and `redeem(shares)` are supported, with `redeem` as the resilient fallback when a single adapter lacks liquidity.
- Share-price accrual happens at read time via live `totalAssets()` summed from adapters; no harvest call required.

### 5.2 Allocation buckets

The vault's assets are allocated across three buckets whose target weights and constituents are governance-determined:

- **Bucket A — Stable yield.** USDC routed across multiple lending venues (Morpho, Aave, Compound, and equivalents) via per-protocol adapters. Diversified across venues to bound single-venue risk. Equal-weight or governance-tilted across active adapters within bounds set by per-adapter caps.
- **Bucket B — Diversified agent tokens.** A set of agent-economy tokens whose membership and weights are determined by `$ROBOTMONEY` holder vote.
- **Bucket C — Revenue-generating tokens.** A set of tokens passing minimum eligibility thresholds (market-cap floor, minimum age, sufficient liquidity) whose membership and weights are determined by `$ROBOTMONEY` holder vote.

Cadence:
- **Bucket weights** (the A/B/C top-level split) are rebalanced on a **monthly** vote.
- **Bucket constituents** (the membership of B and C) are voted on a **weekly** cadence.
- Both cadences are published parameters of the protocol.

Bucket-B and bucket-C tokens land directly in the depositor's wallet at deposit time — they are not held by the vault. The vault custodies only USDC and adapter receipts; the basket leg is a parallel routed swap committed atomically with the deposit, subject to slippage and quote-deadline bounds.

### 5.3 Governance and the `$ROBOTMONEY` token

- Fixed-supply governance token.
- Holders vote weekly on bucket-B and bucket-C constituents and weights.
- Holders vote monthly on the A/B/C top-level weight split.
- The token does **not** entitle holders to vault returns; it entitles them to direct allocation.
- Protocol revenue funds buyback-and-burn of `$ROBOTMONEY`, producing supply reduction over time.
- Vote results and execution paths are observable on-chain. Both web and CLI surfaces expose current weights, active proposals, and recent vote history.

### 5.4 Fees

The protocol levies three distinct fees, each a parameter set by governance:

- **Management fee** — a percentage of AUM accrued continuously and skimmed to the fee recipient.
- **Swap-fee share** — a percentage of swap fees earned on bucket trading activity, routed to the fee recipient.
- **Exit fee** — a percentage of NAV applied to redemptions and withdrawals; baked into the values returned by `previewWithdraw` / `previewRedeem`.

The fee recipient is a multisig-controlled address. All three rates are observable through the vault's read surface.

### 5.5 Agent-facing CLI and skill

A command-line interface (`@robotmoney/cli`) and a Claude-format skill plugin (`robotmoney-cli`) expose the protocol to autonomous software. The CLI is also runnable as an MCP server for agent runtimes that prefer MCP over shell.

Three command categories:

**Read commands** — no wallet required.

| Command | Requirement |
|---|---|
| `health-check` | RPC reachability; vault contract liveness. |
| `get-vault` | Caps, fees, share price, totals. `--verbose` adds per-adapter and per-bucket breakdown. |
| `get-balance` | rmUSDC balance and USDC-equivalent NAV for an address. |
| `get-apy` | Blended APY across active stable-yield adapters. |
| `get-basket-holdings` | Bucket-B/C token balances for an address with USDC valuation; `--no-pricing` skips quoter calls. |
| `get-governance` | Current bucket weights, active proposals, recent vote history. |
| `get-allocation` | Unified view of vault-resident assets and externally delegated strategies. |

**Prepare commands** — emit unsigned transaction sequences for callers signing externally.

| Command | Requirement |
|---|---|
| `prepare-deposit` | Vault leg + bucket leg per current governance weights. Flags include opt-out of either leg, slippage, skip-approve. |
| `prepare-redeem` | Vault redeem of `rmUSDC` shares + optional bucket-token sells (all, percentage, named tokens, named amounts). |
| `prepare-withdraw` | Same as `prepare-redeem` but parameterized by net USDC out. |

Every prepared output includes:
- A **simulation** with state overrides applied so gas estimates and revert decoding reflect post-approval reality on first use.
- A `validUntil` deadline for any quote-bound legs.
- A `simulation.failures[i].expected` flag distinguishing artifact-of-simulation failures from real ones.

**Execute commands** — sign and broadcast end-to-end via a user-controlled wallet (OWS or equivalent).

| Command | Requirement |
|---|---|
| `create-wallet` | Bootstrap a new OWS keystore. Print address and funding instructions (USDC + gas asset). |
| `execute-deposit`, `execute-redeem`, `execute-withdraw` | Build, sign, broadcast, wait for confirmation. Same flag surface as the corresponding `prepare-*` command. |

**Common requirements** across all command categories:
- Stable, documented JSON output schemas.
- Decoded ERC-4626, ERC-20, and protocol-specific custom errors by name (`ERC4626ExceededMax*`, `ERC20Insufficient*`, `TVLCapExceeded`, `PerDepositCapExceeded`, `VaultShutdown`, `EnforcedPause`, `NoActiveAdapters`).
- Built-in RPC endpoint pool with automatic fallback and rate-limit retry; explicit override (`--rpc-url`, `RPC_URL` env) always honored.
- Pre-flight gas-balance check: warn in `prepare-*`, hard-error in `execute-*`.
- Wallet resolution ladder: explicit flag → auto-pick if exactly one wallet → error listing options.
- Passphrase resolution ladder: explicit flag → environment variable → interactive TTY prompt.
- **Up-front gas estimation across all legs** of a multi-tx sequence, so dependent transactions don't fail estimation against pre-approval state. Dependent legs fall back to conservative ceilings supplied by the leg builders.
- Partial-failure reporting that lists any transactions that landed before an abort; pre-broadcast aborts are explicit that no chain state was changed.

### 5.6 Human-facing web application

- Public dashboards: vault state, current bucket composition, NAV history, blended APY, performance.
- Connect-wallet flow for deposits, withdrawals, and governance participation.
- Governance UI: active proposals, vote casting, vote history, weight-change diffs.
- Observability surfaces for buybacks, fee accrual, and protocol revenue.
- Allocation page that unifies vault-resident assets with externally delegated strategies.

### 5.7 Wallet onboarding

For agents and users without an existing wallet, the protocol provides bootstrapping via Open Wallet Standard:

- Local keystore creation under a user-chosen label and passphrase.
- Policy-gated signing — per-day caps, contract allowlists, multisig requirements above thresholds — enforced by OWS, inherited by every product surface that uses the wallet (see §4.1 and §4.2 for concrete policy examples).
- Funding instructions for the chain's gas asset and USDC.
- The wallet is decoupled from any single product surface: the same OWS wallet works across CLI, web, and third-party agent harnesses.

### 5.8 Allocation transparency

- Real-time, public, auditable allocation reporting across both vault-resident assets and externally delegated strategies.
- Per-strategy attribution (which protocol, which weight, which valuation source).
- Both web and CLI surfaces expose the same allocation view.

## 6. Non-functional requirements

- **Schema stability.** Programmatic output schemas are versioned and follow Keep-a-Changelog plus SemVer. Breaking changes are reflected in published reference documentation.
- **Decoded errors.** All revert paths surface decoded custom-error names, not raw revert data.
- **RPC resilience.** Default endpoint pool with retry on rate-limits and automatic failover; explicit override always honored.
- **Pre-flight checks.** Gas balance, allowance state, cap headroom, pause/shutdown state, slippage bounds, and quote freshness validated before broadcast.
- **Determinism.** Calldata encoders, gas math, slippage math, and bucket-weight arithmetic are pure, fuzz-testable, and tested against reference implementations and live forks.
- **Custody minimization.** No surface holds private keys. Signing always happens in user-controlled wallets.
- **Audit trail.** Every state-changing transaction is observable on-chain. Off-chain decisions (governance votes, delegated-strategy allocations) are observable through both web and CLI read surfaces.
- **Test pyramid.** Encoder/math units, integration tests with mocked RPC, end-to-end fork tests against the target chain, and an agent/eval tier that scores LLM tool-use against the skill plugin's frozen prompts.

## 7. Trust and security model

- **Vault contract.** Standard ERC-4626 over OpenZeppelin v5, with `Pausable` plus a custom permanent `shutdown`. Adapter set is governance-managed.
- **Adapters.** Per-protocol thin wrappers that escrow USDC and mint/burn protocol receipts on the vault's behalf. Not directly user-callable.
- **Admin surface.** Cap setters, fee setters, adapter add/activate/replace, and emergency switches are gated to a multisig administrator. Governance vote outcomes flow into admin actions within published bounds.
- **Bucket execution.** Slippage bounds and quote-deadline windows applied to every bucket buy and sell. Bucket and vault legs commit independently — the vault is never put at risk by a bucket-leg failure and vice versa.
- **Custody.** Vault holds USDC and adapter receipts. Bucket-B/C tokens land in the receiver's wallet directly — no intermediate share token, no claim. Keys are held only in user-controlled wallets, with policy-gated signing that the operator configures once and every surface inherits.
- **Governance hardening.** Vote results are public on-chain. Vote-to-execution path is bounded by the multisig admin operating within constraints encoded in the contracts.

## 8. Dependencies

- An EVM chain with native USDC and a mature DEX with permit-based approval (Permit2 / UniversalRouter or equivalent) for atomic bucket execution.
- Lending protocols suitable for stable-yield routing (Morpho, Aave, Compound, and equivalents).
- Open Wallet Standard for the wallet-onboarding flow.
- A regulated USD ↔ USDC on-ramp (Bridge, Beam, Coinbase, Stripe stablecoin payouts, or equivalent) for depositors funded in fiat. Out of band relative to the protocol but on the critical path for fiat-funded user stories — see §4.1.
- Standard EVM tooling: `viem`, OpenZeppelin contracts, TypeScript ≥ 5.4, Node ≥ 20, `pnpm`.

## 9. Out of scope

- **Custodial key management.** The protocol delegates signing to user-controlled wallets in all surfaces.
- **General-purpose wallet UX.** The web app is a depositor and governance interface, not a wallet.
- **Fiat on-ramps and off-ramps.** USD ↔ USDC conversion is out of band; the protocol denominates in USDC.
- **Direct user calls into adapters.** All flows go through the vault.
- **Hardcoded constituent universes.** Bucket-B/C membership is voted, not curated by the protocol team.
- **Hosted custody or hosted signing services.** No surface offers managed custody.
