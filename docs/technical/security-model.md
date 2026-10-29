# Robot Money — Security Model

> Scope: an exhaustive taxonomy of web, web3, and blockchain attacks
> against Robot Money, with the required control for each. This document
> is a **security specification** — it states what must be true, not
> what has been built. Every row is a requirement that must hold at
> production launch and remain true across all future changes.
>
> This document is canonical for the security posture. The guardrails
> in `docs/architecture.md` §8 and the trust model in
> `docs/technical/smart-contracts.md` §5 are summaries that link here. Public-facing risk research lives
> at <https://www.robotmoney.net/smart-contract-risks>; this document
> is the internal counterpart that maps that taxonomy onto our
> architecture and requirements.
>
> Code references point to files in `contracts/` at this repo root.
> Adapter risk inherits from Compound v3 and Aave v3 deployments on
> Base; we do not re-audit upstream code.

## 1. How to read this document

Each section is one attack family. Each row is one specific attack
within that family. The **Required control** column states what must
be true in the shipped system. When a risk is accepted by design
rather than mitigated, the row explains the explicit rationale.

Best-in-class for Robot Money means:

- depositor authority over agent policies is never replaced by operator
  authority;
- privileged protocol changes are delayed, observable, cancellable, and
  executed only after independent signer review;
- autonomous-agent loss is bounded on-chain for deposits, the agent's
  only on-chain action;
- safety-critical signing data comes from live chain reads, not the
  explorer, cached UI state, or agent planner text;
- new vault categories do not enter the Portfolio Router until their
  oracle, liquidity, redemption, legal, and disclosure requirements are
  specified and audited.

This is not an audit attestation. It is a specification that informs
audits, PR review, and deploy verification. Any change to the
codebase, deploy scripts, or operational procedures that would
invalidate a required control must update this document first and
go through explicit approval.

### 1.1 Two systems and their trust boundaries

Owner decision, 2026-10-19. Robot Money is two separate systems. Each is deployed in its own run and tested on its own. The attack families below cover both. This section groups the trust boundaries by system.

**Vaults system** (the treasury product): the vaults (rmUSDC, rmPROTO, rmRWA), their adapters and libraries, VaultRegistry, PortfolioRouter, RouterGovernance and ConsensusRecommendationReceipt. Its trust boundaries:

| Boundary | Who crosses it | What the vaults system trusts |
|---|---|---|
| Governance | The Safe multisig through the TimelockController | Every `ADMIN_ROLE`, every upgrade and freeze, and every router weight change (`RouterGovernance.applyReceipt`, `setDefaultWeights`). Delayed, observable and cancellable (§4, §7). |
| Emergency | The independent emergency key (`EMERGENCY_ROLE`) | De-risking only: pause deposits, drain to idle, exclude an adapter. Never an exit block (§4). |
| Public vault and router surface | Any caller: a human wallet, a script, or the gateway | Nothing. Caps, pause state, slippage floors and share accounting are enforced on every call (§2, §3). |
| Rebalancing input | The receipt submitter, which holds `RECEIPT_SUBMITTER_ROLE` (granted by the Safe through the timelock) and records receipts on ConsensusRecommendationReceipt directly | Nothing on its own. The consensus receipt is the only rebalancing signal the Safe may cite. The vector the Safe schedules through `applyReceipt` is the input; the chain cannot parse the payload, so readers compare the applied vector to the payload (owner decision 2026-10-20). A recorded receipt moves no weight until the Safe applies it through the timelock. |
| Upstream protocols | Morpho, Aave, Compound, Uniswap, Aerodrome, USDC | Accepted upstream trust, monitored (§8). |

**Vaults-system invariant: the dependency rule.** The vaults system has no dependency on the gateway. No vaults-system contract names the gateway, takes it as a constructor or initializer argument, or accepts writes only from it. Rebalancing works with no gateway deployed. So a gateway compromise reaches the vaults system only as one more untrusted caller of its public surface. This is `SYS-1` in `docs/technical/smart-contract-invariants.md`.

**rmpc gateway system** (`rmpc` and the gateway it needs, owner decision 2026-10-19): RobotMoneyGateway and the `rmpc` client. `rmpc` is an agentic cryptographic signer for end users; its one on-chain write is an agent deposit into an allowed vault. The gateway decides whether an agent may deposit, how much, until when, for which depositor and share receiver, into which allowed vault, and forwards the permitted deposit to that vault. It has no withdrawal or router path. It is deployed in its own run after the vaults system; its runbook is to be written. Its trust boundaries:

| Boundary | Who crosses it | What the gateway system trusts |
|---|---|---|
| Depositor authority | The depositor, through `commitAuthorization` / `revealAuthorization` and `setPolicy` | The depositor alone sets an agent's policy. Operator authority never replaces it (§10). |
| Agent authority | The agent key (`AGENT_ROLE`) | Only a deposit the depositor's policy allows: caps, windows, deadline, share receiver (always the owner) and allowed vault (§10). |
| Client host | The `rmpc` planner and signer | The planner never signs. The signer accepts only known calldata shapes (§10). |
| Vaults system | The gateway as a client of the vaults system | Only the public ERC-4626 deposit surface of the contracts the depositor's policy `allowedDestinations` names. The gateway is a general-purpose tool: it pins no vault list, reads no vault addresses from the vaults system, and checks only that a destination is in the policy list (owner decision 2026-10-20). Choosing the destinations is the owner's job, done offline, with `rmpc`'s config naming them at setup. The router is never a destination. |
| Gateway governance | Not decided | Who governs the gateway is an open question for its own release. |

---

## 2. Smart contract — execution & state ordering

| Attack | Required control |
|---|---|
| Classic single-function reentrancy | OZ `ReentrancyGuard` must protect every external state-mutating function that moves assets or calls an external contract in the vault, gateway, and Portfolio Router, including vault deposit/withdraw/rebalance/emergency paths and `RobotMoneyGateway.deposit`, the gateway's single path (the deployed release, v0.5.0, also carries `depositTo`, `withdraw` and router deposit paths). New external mutating functions must be reviewed for reentrancy before merge. |
| Cross-function reentrancy | A single `ReentrancyGuard` instance must cover all asset-moving external state-mutating paths on each contract. Effects must be written before external calls, residual allowances must be cleared after one-shot use, and post-call custody invariants must be checked on every path that temporarily holds USDC or receipt tokens. |
| Read-only reentrancy (oracle/share-price during callback) | All adapter call paths that read balances of external contracts must be enumerated and verified to be free of callback surfaces that could be queried mid-state. This analysis must be published and kept current as adapters are added. |
| ERC-721/1155 callback reentrancy | Vault contracts must not implement `onERC721Received` or `onERC1155Received`. The vault must hold only USDC and adapter receipt tokens. |
| Compiler-level reentrancy bugs | Contracts must use Solidity ≥0.8 and OZ `ReentrancyGuard`. The Vyper `@nonreentrant` regression does not apply; this constraint must be re-evaluated if the toolchain changes. |
| Integer overflow / underflow | All arithmetic must use Solidity ≥0.8 checked arithmetic. `unchecked` blocks are prohibited in any code path that touches user balances, shares, fees, or caps. |
| Unsafe casting | Narrowing casts (`uint256` → smaller type) are prohibited in user-facing code paths. All casts must be reviewed for overflow at the point of introduction. |
| Storage collision or malicious logic via upgradeable proxies | The live Base 8453 contracts are direct deployments and cannot be upgraded in place. **Implemented in code (issue 1808, [ADR-0014](../adr/ADR-0014-governed-uups-upgrades-and-freeze.md), not yet deployed on 8453):** the eight vaults-system contracts (`RobotMoneyVault`, `ProtocolAssetVault`, `AgentTokenVault`, `RwaBasketVault`, `VaultRegistry`, `PortfolioRouter`, `ConsensusRecommendationReceipt`, `RouterGovernance`) plus the gateway (`RobotMoneyGateway`) each run behind their own ERC-1967 proxy on OpenZeppelin's upgradeable bases (pinned v5.0.2), with one implementation artifact for every environment. `GovernedUUPS` gives each proxy one upgrade authority, the Safe-controlled timelock, and a one-way, target-bound `freezeUpgrades(expectedImplementation, expectedCodeHash)`. CI pins every proxied contract's sequential layout, stored structs, linked libraries, ERC-7201 namespaces and the OpenZeppelin submodule commits (`scripts/ci/check-core-storage-layout.sh`); a layout change fails until the snapshot is rewritten and reviewed. **Implemented in clients (issue 1810, upgradeability stage 3):** every `rmpc` write verifies, and the dapp gates its admin writes on verifying, at one block, the gateway proxy's code hash and its live ERC-1967 implementation address and code hash against the approved pin, and refuses an unknown implementation or a failed read; a signed `rmpc` write is bound to the verified implementation (discarded unsent if it changes before broadcast, never reported as a success if it executed under another). The indexer, explorer, dapp and watchdog disclose implementation changes and freeze state; indexed state never authorizes signing. **Still required before a proxied release (upgradeability stages 2 and 4, planned):** the release sheet declares the mode of every proxy and `publish-contracts` refuses an undeclared one (today it deploys every proxy frozen), and the Safe → timelock upgrade and freeze are rehearsed on the Twin fork. Each upgrade requires Safe → timelock authorization, the layout gate, linked-library and bytecode review, fork rehearsal, and on-chain implementation verification. A final mainnet proxy must be frozen atomically at deployment or have an explicit production proving period followed by a one-way timelocked freeze. Adapter proxies remain prohibited; adapter address/codehash and no-proxy checks remain in force. See [contract upgradeability plan](contract-upgradeability-plan.md). |
| Self-destruct / `SELFDESTRUCT` ejection | No `selfdestruct` or `CREATE2`-replace pattern may be present in any contract. Post-Cancun semantics reduce this risk but the prohibition stands. |
| Delegatecall to attacker-controlled target | A core proxy delegates only to its ERC-1967 implementation, which only the timelock can change and only while unfrozen (`GovernedUpgrade.upgradeToAndCall` also requires the new implementation's `proxiableUUID`). An implementation delegates only to externally linked libraries whose addresses are fixed in its bytecode and pinned by the layout gate: `GovernedUpgrade` (the upgrade and freeze rules), `GatewayWindows`, `RobotMoneyVaultOps`, `BasketSwaps`, and the existing basket libraries. Vault and adapter business logic must not delegate to a caller-controlled target; any other delegatecall needs explicit review and justification. |
| Adapter codehash allowlist bypass via delegatecall proxy | Approved RobotMoneyVault strategy adapters must be direct (non-proxy) deployments whose runtime bytecode contains no `DELEGATECALL` opcode (`0xF4`). This is enforced at deploy time by `AdapterBytecodeGuard.requireNoDelegatecall` in `contracts/script/DeployVault.s.sol::_approveAdapter` and regression-tested in `contracts/test/AdapterDelegatecallGuard.t.sol` against every currently approved adapter (Aave V3, Compound V3, Morpho, Passthrough). Any future proxy-pattern adapter must instead pin both proxy and implementation codehashes in the allowlist, and the policy update must ship in the same PR. |
| Uninitialized storage / proxy initializer | Each core proxy is initialized in its own constructor (`new ERC1967Proxy(implementation, initialize(...))`, the deploy scripts and `UpgradeAuthority._deployProxy`), so no transaction sees it uninitialized. `initialize` calls every parent initializer once; a replay reverts `InvalidInitialization`; implementation constructors disable initializers. The release mode is a required initializer argument with no default (`Undeclared` reverts). The upgrade authority initializes once per proxy (`GovernedUpgrade.init` refuses a second call, so a reinitializer cannot rename it), nothing writes the frozen flag back to false, and `freezeUpgrades` disables every later initializer and reinitializer. A versioned reinitializer runs only inside the timelock's `upgradeToAndCall`. Tested in `contracts/test/GovernedUpgrade.t.sol`. |
| Recursive self-liquidation (Euler-class) | No lending or liquidation logic may be present in the vault. This constraint must be re-evaluated if the product shape changes. |

---

## 3. Smart contract — accounting & supply

| Attack | Required control |
|---|---|
| ERC-4626 inflation / first-depositor share-price attack | `RobotMoneyVault._decimalsOffset()` must return `18`, configuring OZ virtual shares to `10^18`. The deploy runbook must require a seed deposit of ≥ 1,000 USDC before the vault is opened to the public. This must be verified in CI fork tests. **CI coverage:** `DeployVault.s.sol` (the vault stage) includes a mandatory seed deposit step (`SEED_DEPOSIT_AMOUNT`) in `run()` and `runInProcessWithSeed()`; `contracts/test/DeploySeedDeposit.t.sol` (`DeploySeedDeposit`) asserts `vault.totalAssets() >= 1_000_000_000` and `vault.totalSupply() > 0` before any public deposit; this test is wired into the `forge-fork-vault-regressions` CI job in `suite-01-02-forge-tests.yml`. |
| Donation-to-reserves bypass (Euler/Venus class) | `totalAssets()` must be defined and documented to prevent direct ERC-20 transfer manipulation. The accounting model must be published and verified via fork tests that show a large direct USDC donation does not materially advantage a subsequent depositor. |
| Supply-cap bypass via direct transfer | `tvlCap` must be enforced on the deposit path. `totalAssets()` accounting must be shown to not allow a direct-transfer-inflated cap bypass. |
| Per-deposit-cap bypass via splitting | `perDepositCap` is per-call by design for rate-shaping, not anti-Sybil. This is an accepted limitation; it must be documented in the public risk disclosure. |
| Exit-fee evasion via flash loan | `MAX_EXIT_FEE_BPS` must be a `constant` ceiling in the implementation bytecode (ADR-0014 §2: constants stay constants; see §4, "Fee parameter manipulation above ceiling"). No in-protocol primitive may allow bypassing the fee. |
| Fee accrual rounding | `previewWithdraw` and `previewRedeem` must round consistently in favor of the vault. A published rounding analysis must confirm no dust-siphon path exists. |
| Withdrawal-routing griefing | The withdrawal path must cap partial pulls at the available adapter balance. `forceRemoveAdapter` must accept explicit loss write-off. |
| Stuck-token / fund recovery abuse | No admin or role-gated function may send a protocol or depositor asset to a caller-chosen address (custody invariant INV-1): the arbitrary-recipient `rescueTokens`/`rescueUsdc` functions are deleted on every contract. A foreign token leaves only through the permissionless `sweepForeignToken`, which reverts `TokenIsProtected` for a protected token and sends to a quarantine address no caller chooses (`contracts/lib/ForeignTokenQuarantine.sol`). `RobotMoneyVault` protects `asset()` and `address(this)`, and sends to its timelock-governed `quarantineAddress`. `BasketVault` protects USDC, its share token and every basket asset, active or removed, and sends to the fixed `ForeignTokenQuarantine.QUARANTINE`. Each lending adapter protects USDC and its own receipt token. A balance that reappears on a removed basket asset is swapped back into NAV by the permissionless `reabsorbRemovedAsset` (INV-2). When that asset's TWAP read reverts, the call sends the balance to the fixed quarantine instead (`BasketSwaps.reabsorb`). |

---

## 4. Smart contract — access control & admin

| Attack | Required control |
|---|---|
| Single-EOA admin compromise | No EOA may hold `ADMIN_ROLE` directly on any contract. `ADMIN_ROLE` must be held exclusively by the `TimelockController`. Agent and keeper roles must be separated from `ADMIN_ROLE`. |
| PROPOSER_ROLE held by a plain EOA | The `TimelockController` PROPOSER_ROLE and CANCELLER_ROLE must be held by a Safe multisig with a minimum threshold of 2-of-N signers. EXECUTOR_ROLE should be open (`address(0)`) so any address can execute an already-delayed, already-authorized operation after the delay; if a restricted executor is used, it must be a Safe with threshold ≥ 2 and the liveness tradeoff must be documented. `DeployTimelock.s.sol` must verify at deploy time that every Safe address has deployed code and `getThreshold() >= 2`. The Safe address, threshold, executor policy, and canceller policy must be recorded in this document at deploy time (§4.1). **Decided policy (owner, 2026-10-05):** proposer and canceller are the Safe (threshold ≥ 2); executor is open (`address(0)`); the timelock has no admin (`admin = address(0)`). `DeployTimelock.s.sol` sets `executors = [address(0)]` and records `executorPolicy` and `cancellerPolicy` in `timelock.json`; the stage 12 verifier asserts the on-chain holders match (core #1521). The timelock it deploys is `ProposerFloorTimelock` (`contracts/ProposerFloorTimelock.sol`): a `TimelockController` whose `_revokeRole` refuses to drop the last `PROPOSER_ROLE` holder, `revokeRole` and `renounceRole` alike, so the Safe cannot leave every `ADMIN_ROLE` function unreachable by giving up its role (issue #1645 question 1, QA plan v1 B3); the govern tool refuses `timelock-revoke-role PROPOSER_ROLE` for the last holder before anything is sent. |
| `ADMIN_ROLE` self-grant escalation | `ADMIN_ROLE` is its own admin by design. All role changes must route through the `TimelockController`. The Safe multisig must enforce quorum independently. |
| Timelock bypass | A `TimelockController` must hold `ADMIN_ROLE` on all governed contracts. The production delay for high-risk operations must be ≥ 48 hours; any lower-delay operation class must be explicitly enumerated with its rationale, maximum authority, and affected functions. Admin operations must route through `schedule → delay → execute`; direct `ADMIN_ROLE` calls from any address must revert with `AccessControlUnauthorizedAccount`. The deployed timelock address, min delay, proposers, executors, cancellers, pending operations, and operation salts must be verifiable via `rmpc get-timelock` and the dapp timelock panel. |
| Pause-key abuse (denial of deposit) | The pause role must be separable from `ADMIN_ROLE`. Pause must halt new deposits only. Withdrawals are never frozen, by anyone: no role, flag or function on any vault, the gateway or the router can block a redeem (core 1494). Pause must not be able to move funds. The pause role should be held by a lower-quorum guardian to allow fast response; the unpause role must require `ADMIN_ROLE` through the timelock. |
| Emergency-role abuse to drain | `EMERGENCY_ROLE` must return funds to the vault only, never to an attacker-chosen address. `emergencyWithdraw` must use `try/catch` per adapter to prevent a single bad adapter from blocking recovery. A hot-key exclusion must move no value between holders: `RobotMoneyVault.emergencyExcludeAdapter` and `forceRemoveAdapter` open an exclusion record for a funded adapter, so what it later returns is paid pro rata to the holders at that moment, and only `ADMIN_ROLE` (the timelock) can restore an excluded adapter (security round 1). When an adapter is illiquid the order is exclude, then drain: `emergencyWithdraw` before the exclusion lets early redeemers take full NAV from idle while the haircut falls on the holders who stay. Until `EMERGENCY_ROLE` acts, a venue that shuts withdrawals (Aave reserve paused or inactive, Comet withdraw pause) builds no new idle: rmUSDC's `maxDeposit` reads 0 while an active adapter's `venueWithdrawable()` is false, and the adapter's `deploy` reverts `VenueWithdrawalsClosed` instead of handing a slice back, so neither a deposit nor a keeper `rebalance` can fund a par exit (security round 3). |
| Fee parameter manipulation above ceiling | `MAX_EXIT_FEE_BPS` is a `constant` in implementation bytecode, never storage, never an initializer argument and never behind a setter (ADR-0014 §2: constants stay constants). No role, setter or initializer can change it. Before a freeze only a governed upgrade can, so every upgrade review checks that each ceiling is kept or tightened, and the upgrade sits in public view for the full timelock delay with withdrawals open; after a freeze the ceiling is fixed forever. `setExitFeeBps` and the initializer must both revert above this ceiling. Raising a ceiling needs a new ADR. |
| Rebalance-throttle removal | Rebalance interval floor and bps ceiling (`MIN_REBALANCE_INTERVAL_FLOOR`, `MAX_REBALANCE_BPS_CEILING`) must be `constant`s under the same rule as `MAX_EXIT_FEE_BPS`. Admin must not be able to remove these constraints. |
| Fee-recipient swap to attacker address | `setFeeRecipient` must be admin-gated and routed through the timelock. The fee recipient must be verified to be a non-zero address. |
| Multisig social engineering (Drift-class) | A signer playbook must be published and followed. Signers must independently simulate the operation before approving, review the calldata diff against the expected effect, and meet a minimum deliberation time. No signer may approve on the same device as the proposer. |
| Signer-device compromise | Safe owners sign with encrypted keystores unlocked by a typed passphrase or, at each owner's choice, with a hardware wallet bound to the owner address (`ledger:PATH@0xOWNER`, `trezor:PATH@0xOWNER`); hardware is optional, never required (owner decision 2026-10-14). No plaintext key, no passphrase file and no passphrase held in the environment may sign any `ADMIN_ROLE` or `PROPOSER_ROLE` operation on chain 8453. |
| Safe whose signers cannot sign (lock-out at the handover) | Stage 11 gives every role on every vault to a timelock whose proposer is the Safe. A Safe whose real keys cannot sign would lock every vault for good, and comparing owners and threshold with the sheet proves the addresses only. Before stage 11 the real Safe must execute one self-call (value 0, empty data) signed by EVERY owner (core #1618, plan decision 21). The run manifest records the transaction hash and the signers, stage 11 refuses without that record on the same Safe and a Safe nonce of 1 or more, and the stage 12 verifier reads the transaction back from the chain and recovers every signer. The proof goes through the Safe, never the timelock. |
| Upgrade authority substitution | Only the proxy's `upgradeTimelock()`, the Safe-controlled `TimelockController`, can call `upgradeToAndCall` or `freezeUpgrades`. It is written once at initialization and is not an AccessControl role, so `ADMIN_ROLE`, `DEFAULT_ADMIN_ROLE`, `EMERGENCY_ROLE`, the deposit pauser, the deployer, RouterGovernance and the Safe itself hold no upgrade power, and no grant, revoke or renounce changes that. The timelock is still deployed last: every proxy names the CREATE2 address of the exact Safe-proposer timelock (`UpgradeAuthority.predictTimelock`), which nothing else can occupy, so there is no interim deployer authority; the timelock stage deploys it there and refuses the handover unless every core proxy names it. A freeze is one-way and bound to the reviewed implementation and code hash, so a queued freeze cannot lock in a version an intervening upgrade installed, and a frozen proxy refuses new and previously queued upgrades. Freezing never pauses or alters withdrawals. Tested in `GovernedUpgrade.t.sol`, `UpgradeAuthorityStages.t.sol` and, on the Twin fork through the canonical Safe, `UpgradeLifecycleFork.t.sol`. |
| Role separation drift | At deploy and at every admin operation, an off-chain assertion must confirm that admin, pause, emergency, agent, proposer, canceller, and executor authorities satisfy their documented separation rules. No account may hold more than one of gateway `ADMIN_ROLE`, `DEPOSIT_PAUSER_ROLE`, or `AGENT_ROLE`. The gateway refuses a reveal for an address holding `ADMIN_ROLE` or `DEPOSIT_PAUSER_ROLE`. |

### 4.1 Deploy-time governance record

> Note (2026-10-19): Deploy 2 below deployed both systems in one run. The vaults system and the rmpc gateway system now deploy in separate runs (§1.1). The Deploy 2 column stays as recorded.

Every Base 8453 deployment fills a column of this table from its stage 11 manifests (`safe.json`, `timelock.json`, `gateway.json`) and its stage 12 verifier output. The live column is Deploy 2: devops run 2, release `release/v0.4.0-base.3-rehearsal`, core `78c50cbd`. Its manifests are committed byte for byte in `deployments/8453/deploy-2/`, and its verifier output is in run 2's evidence folder on the operator machine (`docs/development/stage-deployment.md`, "Deploy 2"). Two rows differ from the production policy: the delay is 900 s because Deploy 2 is a rehearsal-kind deployment, and its timelock predates `ProposerFloorTimelock`. The final production deployment adds its own column.

| Item | Decided policy | Deploy 2 (Base 8453, rehearsal kind) |
|---|---|---|
| Safe address (SafeL2 v1.4.1, canonical factory) | Holds `PROPOSER_ROLE` and `CANCELLER_ROLE` | `0xdFDea0E1AdF55a9a938bD34ead7920175b47Cb4b`, version 1.4.1 from factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, created in block 52484018 (`safe.json`). `timelock.json` records `safe_is_timelock_proposer` and `safe_is_timelock_canceller` true. |
| Safe owners and threshold | Three independent owner keys, threshold 2 | Threshold 2 of 3 owners: `0xa5dAD878b268bCf5c31E61b3bd665AEF61feA5CE`, `0x5c6b2a1fa3A59aCc9C943Cc93FAD204fBfB0935a`, `0xB3cAbaD71CE97f582DCfdB5966294b8e4B7B7180` (`safe.json`). |
| Timelock address and `getMinDelay()` | At least 172800 s on 8453. A rehearsal-kind run (`DEPLOYMENT_KIND=rehearsal`) takes 900 s up to 172799 s instead (issue 1727). | `0xd65165AF0Fb4062ED0da5D119d4B56B92b15356b`, 900 s (`timelock.json` `min_delay`). |
| Timelock contract | `ProposerFloorTimelock`, which refuses to drop the last `PROPOSER_ROLE` holder (§4, QA plan v1 B3) | A stock OZ `TimelockController`: core `78c50cbd` predates B3, so on Deploy 2 the last `PROPOSER_ROLE` holder (the Safe) can still be dropped by a scheduled `revokeRole` or by its own `renounceRole`. |
| Executor policy | Open (`address(0)`), recorded as `executorPolicy` in `timelock.json` | `open` (`executorPolicy`, and `timelock_executor_is_open` true). |
| Canceller policy | The Safe only, recorded as `cancellerPolicy` in `timelock.json` | `safe-only` (`cancellerPolicy`). |
| `ADMIN_ROLE` handover | The timelock holds `ADMIN_ROLE` on every protocol contract and the deployer holds none | The timelock holds it on the vaults (`vaults_handed_over_count` 3 from v0.6.0, 4 on the live v0.5.0 line), the gateway (gateway: v0.5.0 only), registry, router and governance, and every `deployer_*` role flag is false (`timelock.json` `roles`). |
| Gateway agents authorized by the deploy | None (the sheet refuses `AGENT_*` inputs, see §13 Deploy-time protocol agent) | None: `gateway_agents_listed_count` 0 and `timelock_owned_agents` empty (`timelock.json`) (gateway: v0.5.0 only). |

Deploy-time configuration (setters, eligibility, router default weights, at launch rmUSDC 9500, rmPROTO 500, rmRWA 0 bps) is set by the deployer before stage 11. There is no voting configuration: RouterGovernance has no voter, power or quorum (core 1698). **Initial deposit state, one rule for all three vaults** (`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`, issue 1705): all three vaults deploy paused, and stage 13 unpauses all three through the Safe and the timelock. Stage 13 holds only the four vault deposit unpause operations, one timelock operation per vault.

---

## 5. Smart contract — oracle & pricing

| Attack | Required control |
|---|---|
| Spot-price manipulation via flash loan (Harvest-class) | The vault must not consume DEX spot prices. Share price must equal `totalAssets() / totalSupply()` against per-adapter accounting only. Any future adapter that consumes a price source must document the oracle and its manipulation resistance. |
| TWAP / VWAP poisoning | No TWAP or VWAP may be consumed by any vault unless a manipulation-resistance analysis is published, a minimum TWAP window is specified, and a circuit breaker is in place. |
| Stale-price oracle | Adapters that depend on upstream oracles (Compound v3, Aave v3) must document the oracle freshness requirement and the upstream circuit-breaker behavior. This is an accepted upstream-trust assumption. |
| Single-source oracle | Any adapter that introduces a new price source must use at least two independent oracle sources or a TWAP with documented staleness tolerance. |
| Dead-market pricing without circuit breaker (YieldBlox-class) | Accepted as an upstream venue risk for Compound v3 and Aave v3. A monitoring alert must exist for each venue going offline. Implemented by the venue-liveness monitor — see [docs/technical/upstream-monitoring-runbook.md](./upstream-monitoring-runbook.md#venue-offline). |
| Cross-chain oracle desync | Not applicable while the product is deployed on a single chain. Must be re-evaluated before any multi-chain expansion. |

### 5.1 BasketVault TWAP configuration (issue #451)

`BasketVault` is the first contract in the codebase to consume a DEX price
source. The manipulation-resistance posture is:

- **Price source.** Uniswap V3 `IUniswapV3Pool.observe()` returning the
  cumulative tick over the configured per-asset window. The arithmetic-mean
  tick is converted to `sqrtPriceX96` via the minimal `TickMath` port in
  `contracts/lib/TickMath.sol` and then to a USDC quote using the existing
  ratio math. `slot0()` is never read on hot paths.
- **Minimum window.** `MIN_TWAP_WINDOW = 600 s` (10 minutes). Floors any
  ADMIN_ROLE write so a single setter call cannot collapse the oracle to
  near-spot pricing.
- **Maximum window.** `MAX_TWAP_WINDOW = 86_400 s` (24 h). Caps observation
  buffer pressure and keeps NAV responsive on slow-moving assets.
- **Default window.** `DEFAULT_TWAP_WINDOW = 1_800 s` (30 minutes) applied
  on first read for any asset whose `twapWindow` has not been set.
- **Cardinality requirement.** ADMIN_ROLE must verify off-chain that the
  pool's observation cardinality covers the configured window across
  expected block intervals (call
  `pool.increaseObservationCardinalityNext(...)` if not). Insufficient
  cardinality causes the pool's `observe()` to revert (`"OLD"`), which
  fails NAV and emergency-unwind reads closed — preferred to silently
  reading a manipulable short window.
  On-chain, `addAsset` and `setTwapWindow` now refuse a pool whose cardinality is
  below `window / 2 s + 1` (901 for the default window), so griefing swaps cannot
  churn the ring below the window. `redeemInKind` is the oracle-free exit if a
  read still fails (core 1665, ADR-0007 amendment).
- **Circuit breaker.** `pauseDeposits()` (EMERGENCY_ROLE) suspends new
  deposits only. Withdrawals are never frozen, by anyone (core 1494).
  `shutdownVault()` zeroes the TVL cap. Both remain available
  if a TWAP-derived NAV starts looking anomalous.
- **Single-source disclosure.** BasketVault currently relies on a single
  Uniswap V3 pool per asset. The TWAP window is the documented
  manipulation-resistance control. Governance cannot set a window longer
  than the pool's observation history: `setTwapWindow` refuses it with
  `InsufficientObservationHistory`, because such a window would make every
  NAV read revert and block every redeem (core 1494); production deployments that require a
  second source must wrap the vault behind an adapter that cross-checks
  the TWAP against an independent oracle (Chainlink, etc.) before being
  marked router-eligible in the registry.
- **Production gate.** Router eligibility for any vault (basket-vault
  or otherwise) is registry state:
  `VaultRegistry.isRouterEligible(vault)`, flipped by ADMIN_ROLE via
  `setRouterEligible`. `PortfolioRouter` refuses to weight or deposit
  into a vault whose flag is false. Basket vaults stay false by default
  — ADMIN_ROLE only flips them eligible after asserting the above
  prerequisites (TWAP window, observation cardinality, liquidity floor)
  for every active asset. The single registry flag replaced the
  in-contract `isPrototype()` / `prototypeOverride` /
  `nonPrototypeAttested` machinery in issue #475 so the same contract
  ships into every environment; only the flag's value differs. See
  `docs/development/single-production-codebase.md`.

---

## 6. Smart contract — cross-chain & bridges

| Attack | Required control |
|---|---|
| Weak DVN / verifier configuration (Kelp-class) | No bridge or message-passing layer is in scope. This section must be re-scored in full before any bridge integration ships. |
| Compromised relayer / verifier signing | Same — no bridge in scope today. |
| Replay across chains | All signed transactions must include a chain-id binding (EIP-155). `rmpc` must verify chain-id on every operation. |
| Message ordering / reorg-induced double-spend | Accepted Base sequencer / L2 reorg risk. A minimum confirmation depth policy must be documented and enforced by `rmpc`. |
| Bridge-locked-funds custody risk | The product must not bridge user funds. Any future bridge integration requires an explicit ADR. |

---

## 7. Smart contract — economic & governance

| Attack | Required control |
|---|---|
| Flash-loan governance takeover (Beanstalk-class) | There is no token-based governance and no voting by anyone. Router weights change only when the Safe, through the timelock, applies a consensus receipt, so no token balance, spot or borrowed, buys any authority. |
| Same-block schedule-and-execute | Every governance execution, a weight change included, is a `TimelockController` operation with the mandatory delay between schedule and execute. |
| Bribery markets | There is no governance token and no voter, so there is no voting power to buy. The residual risk is a Safe signer being paid off-chain; the Safe threshold and the timelock delay are the controls, and the owner set is changed on the Safe itself. |
| Treasury drain via malicious proposal | Treasury operations must be gated by the multisig-backed timelock. A treasury-drain proposal must be detectable and cancellable within the timelock delay window. |
| Weight-setter capture | `WEIGHT_SETTER_ROLE` is held by `RouterGovernance` alone, and the timelock holds `ADMIN_ROLE` and `RouterGovernance`'s own `WEIGHT_SETTER_ROLE` on it, so a weight change is one Safe-scheduled timelock call (`apply-receipt`: `RouterGovernance.applyReceipt` releases the consensus receipt and applies its vector). `RouterGovernance` has no propose, vote or execute function (issue 1698). Router-weight governance must not grant authority over vault internals, fees, adapters, or agent policies. |
| Router-weight whiplash | Every weight change passes the timelock delay (172800 s on 8453) only while the weight setter is timelock-gated: the router's one `WEIGHT_SETTER_ROLE` holder runs the `RouterGovernance` build, whose weight writes are all gated by roles only the timelock holds: `applyReceipt` by its own `WEIGHT_SETTER_ROLE`, `setDefaultWeights` by its `ADMIN_ROLE`. A rotation installs whatever contract the Safe chose (ADR-0002, "Why the 1522 bypass stays closed"). A target that forwards Safe calls, or any holder the timelock does not gate alone, makes every later weight change undelayed. The rotation itself waits the delay and its target is public, so that window is when such a target must be cancelled. The stage 12 verifier records the current holder's gating (`weightSetterGating` in the verify stage record, the `verify.weight_setter_gating` log line) and fails `router: every WEIGHT_SETTER_ROLE holder is timelock-gated` on any other gate (QA plan v1 C3). The dapp and `rmpc get-governance` must surface the pending operation and the current weights before it executes. |
| Router weights changed outside the timelock | The timelock applies router weights through `RouterGovernance.applyReceipt` (the `apply-receipt` row), gated by `RouterGovernance`'s `WEIGHT_SETTER_ROLE`, which the timelock holds. `WEIGHT_SETTER_ROLE` is the only `setWeights` gate and only RouterGovernance holds it. The role is its own role admin, so the timelock cannot grant itself the role. `ADMIN_ROLE` is the `defaultWeights` gate (`setDefaultWeights`) and the timelock holds it. A direct `setWeights` from the timelock, the Safe, the deployer or any EOA reverts with `AccessControlUnauthorizedAccount` (core #1522). RouterGovernance is replaced by a bounded rotation (core #1616, ADR-0002): the Safe alone proposes a contract target (`WEIGHT_SETTER_ROTATOR_ROLE`), the timelock alone executes it (`WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE`) after its own delay measured from the proposal, the Safe can cancel, and execution leaves exactly one holder. Both rotation roles are self-administered, so the timelock cannot grant itself either one. The stage 12 verifier fails a run while a rotation is pending. |
| Applied vector cleared or reset to a fallback | No contract function clears the router's applied vector or resets it to a hard-coded fallback (issue 1988, ADR-0002 amendment 2026-10-29): a clear that ran in production by accident would stop the router following the Investment Committee's receipt with no new receipt. `PortfolioRouter` and `RouterGovernance` carry no clear, no tool row calls one and the runbook validator (`scripts/runbook/validate-contract-qa.ts`) refuses a step that would. Recovery from a bad applied vector is a newer receipt: the Safe applies it through the timelock with `apply-receipt`. A vault retired under an applied vector keeps its leg in that vector until the next receipt; the router skips the leg (the vault is not registry-Active) and `setWeights` refuses a vector that names it. The routers of Deploy 3 and earlier keep the pre-1988 clear until a governed router upgrade replaces them. |
| `WEIGHT_SETTER_ROLE` replacement | The role is its own role admin and the deployer copy is revoked at stages 6 and 11, so no role admin can grant or revoke it. Making `ADMIN_ROLE` the role admin again would re-open the timelock bypass of core 1522. Replacing `RouterGovernance` is a bounded rotation (core 1571, ADR-0002): the Safe proposes, the timelock executes, one holder remains. The old `RouterGovernance` keeps router `ADMIN_ROLE` unless the rotation is scheduled as one atomic timelock batch that also grants the new governance `ADMIN_ROLE` and revokes the old one's. The router refuses itself, the Safe and the timelock as targets. A target must not be able to grant `WEIGHT_SETTER_ROLE` to many holders (the revoke loop costs about 19k gas per holder). The rotation delay is the timelock's own `getMinDelay()`. Only replacing the gateway or the router themselves needs a redeploy, which cascades to `RouterGovernance`, the receipt, and a `setRouter` re-link of the registry. See ADR-0002 and `docs/technical/router-governance-handoff-runbook.md` §1.1. |
| MEV sandwich on rebalance | `rebalance()` must enforce a throttle (minimum interval, maximum bps per call). Large rebalances must use private orderflow or commit-reveal to prevent sandwich extraction. The acceptable sandwich loss threshold must be documented. |
| MEV sandwich on user deposit/withdraw | Vault deposits and withdrawals must move USDC ↔ shares at internally computed ratios with no DEX slippage surface. Any future bucket-B/C leg that touches DEX liquidity must specify and enforce a slippage bound. |
| JIT liquidity / inspection-and-front-run | The share-price computation must not expose a profitable front-run surface. This must be verified in the economic-model audit before bucket-B/C ships. |

---

## 8. Smart contract — dependency & legacy code

| Attack | Required control |
|---|---|
| Pre-0.8 integer overflow inheritance | All contracts must use Solidity ≥0.8. OZ dependency versions must be pinned in `foundry.toml` / `package.json`. Any dependency upgrade requires a PR with an explicit compatibility review. |
| Unverified bytecode | All production contracts must be verified on BaseScan within one hour of deployment. The verified source must match the tagged commit in this repository. Deployment runs the `publish-contracts` CLI in this repo, the only deploy driver (`publish-contracts/README.md`; architecture §7.3). Its stage 12 verifier proves from the chain that every deployed address runs the tagged build (`runtime code equals build artifact (masked)`). Explorer source verification (Blockscout, Sourcify; `bun run ops sourcify-submit`) is publishing, not a gate: it depends on third-party vendors, so `verify --check-sources` runs it on demand only (owner decision 2026-10-19). |
| Compromised npm/cargo dependency | `cargo audit`, npm/Bun dependency audit, and lockfile-integrity checks must run in CI and block on high-severity findings. Solidity, Rust, JS, and GitHub Actions dependencies must be pinned to exact versions or immutable SHAs. Any dependency update requires an explicit review comment in the PR. |
| Compiler-bug exposure | Before each production deployment, the Solidity known-bug list for the compiler version in use must be reviewed and any applicable bugs documented and addressed. |
| Adapter target contract upgrade | Compound v3 and Aave v3 are upgradeable by their own governance. This is an accepted upstream-trust assumption. A monitoring process must alert on upstream governance proposals that affect our adapter interfaces. Implemented by the governance-proposal monitor — see [docs/technical/upstream-monitoring-runbook.md](./upstream-monitoring-runbook.md#governance-proposal). |
| Token-rebase or fee-on-transfer upstream change | USDC is upgradeable by Circle. A monitoring process must alert on Circle upgrade proposals. The vault must have a documented pause-and-review procedure if USDC semantics change. Implemented by the USDC-upgrade monitor — see [docs/technical/upstream-monitoring-runbook.md](./upstream-monitoring-runbook.md#usdc-upgrade). |

---

## 9. Smart contract — circuit breakers & monitoring

| Attack | Required control |
|---|---|
| No anomaly detection on mint/burn rate | An automated watchdog must monitor per-block and per-hour mint and burn volume against defined thresholds. Breach must trigger an automated deposit pause or alert to an on-call operator with a maximum response-time SLA. |
| Manual incident response too slow | On-chain events (cap saturation, large single deposits, adapter balance deviations) must feed an automated alert system. The on-call rotation and escalation path must be documented. |
| Pause-trigger key not pre-positioned | A guardian role with lower quorum than the full Safe must be able to pause deposits without going through the timelock. This guardian may not unpause deposits; that requires `ADMIN_ROLE` through the timelock. |
| Missing on-chain kill switch for adapter | `forceRemoveAdapter` must exist with explicit loss-acceptance semantics. Every adapter deployment must confirm this path is exercised in tests. |
| Dismissed audit finding later exploited (Venus-class) | Every audit finding must be logged in `docs/audits.md` with a disposition: fixed, accepted-with-rationale, or dismissed-with-rationale. Dismissed findings must be reviewed before any major change that touches the relevant code path. |

---

## 10. Off-chain — agent access layer (`rmpc` and gateway)

This section covers the rmpc gateway system (§1.1). It maps onto `docs/architecture.md` §5.1 (`rmpc`), §5.2 (Agent Permissions Gateway), §6 (Data and Trust Boundaries) and §8 (Guardrails).

| Attack | Required control |
|---|---|
| Prompt injection of agent planner causing unsafe asset movement | The planner must not be able to sign. The gateway must enforce role, amount caps, the allowed-vault list, deadline, idempotency, share receiver, and deposit pause state independently of any agent-side state. `rmpc` must verify chain id, runtime code hash, and configured addresses before building calldata. When the gateway is an ERC-1967 proxy, `rmpc` also reads the implementation slot and that implementation's code at one block and refuses with `ErrImplementationNotApproved` unless its code hash is listed in `gateway_implementation_hashes` (preflight check 2b, ADR-0014 P3), because an upgrade leaves the proxy's own code hash unchanged. |
| Agent key exposure | Agent keys must be constrained to the gateway deposit (`AGENT_ROLE`) only. An agent's one on-chain action is a deposit into an allowed vault, with shares minted to the share receiver, always the owner (owner decisions 2026-10-19 and 2026-10-20). Loss model: a leaked agent key loses the agent wallet's USDC balance plus any live gateway allowance. The gateway caps only what passes through it. Funding discipline (wallet balance, allowances) is the owner's responsibility, never the protocol's. The agent has no withdrawal path, so it never touches vault shares. |
| Owner key compromise | A compromised owner key takes all swept shares and agent control in one step, because the owner is the receiver. The owner should be a Safe or a hardware account. The gateway has no per-agent protocol lever: the pause is global, the owner's `revokeAgent` is the only targeted stop. The reveal must come from the depositor's own account; no meta-transaction or forwarder path exists (owner decision 2026-10-20). |
| Client host compromise | The signer API must be narrow and accept only known calldata shapes for the gateway deposit into a vault and for reads. `rmpc` has no other on-chain write. On-chain caps, allowlists, recipients, and deadlines are the backstop regardless of client state. |
| Local state rollback | Idempotency keys, cap usage, policy expiry, the allowed-vault list, and share receiver must be enforced on-chain, not in local state. |
| Malicious or stale RPC | `rmpc` must verify chain-id and gateway code hash on every operation, and for a proxied gateway its live ERC-1967 implementation address and code hash against the configured `gateway_implementation` and `gateway_implementation_runtime_hash` (issue 1810; a failed slot or code read is a refusal, never a pass). Multi-RPC comparison must be supported for high-value operations. |
| Software-key extraction | An encrypted software keystore signs on every chain, Base mainnet included. A hardware wallet, HSM, KMS, Secure Enclave or TPM is optional, never required (owner decisions 2026-10-06 and 2026-10-14; architecture §10 "Production signer vendor"). Software key signing requires the explicit opt-in `[signer].allow_software_fallback = true` (else `ErrSoftwareSignerDisallowed`), and `rmpc` prints the production warning before every write on Base mainnet. `rmpc` signs only from an encrypted-at-rest keystore (`SignerBackendKind::Software`) and takes no raw private key. |
| Pause abuse via agent role | The agent role must not be able to trigger pause. Role separation must be enforced at the contract level, not by convention. |
| Replay of signed transaction across chains | Chain-id check must be present in `rmpc` and enforced by EIP-155 signing. |
| Replay within chain (nonce reuse) | Per-agent nonce file lock must prevent concurrent invocation. `ErrConcurrentInvocation` must be the documented error path. |
| Race between concurrent agent tasks | The nonce lock must be the single serialization point. No other coordination mechanism should be introduced without an explicit ADR. |
| Idempotency domain collision | Gateway idempotency identifiers must domain-separate operation kind, chain id, gateway address, agent, order id, amount, destination vault, share receiver, and caller-provided idempotency key (issue #679: an operation-kind constant is prepended to every hash computation in `RobotMoneyGateway`). |
| Signer-backend MITM | Trust collapses to the signer device. Hardware signer attestation is the accepted mitigation. |

---

## 11. Off-chain — dapp / frontend / web2

| Attack | Required control |
|---|---|
| Frontend JS injection (Bybit/Safe-class) | The dapp must be deployed with a strict Content Security Policy that disallows inline scripts and eval. Public production builds must be static, content-addressed or content-hash deployed, and reproducible from a signed tag. Third-party or CDN scripts are prohibited by default; if an exception is approved, Subresource Integrity hashes are required. The canonical deployment procedure must be documented and enforced. |
| Build-pipeline compromise | Dapp release artifacts must be reproducibly buildable from a tagged commit. Release tags must be signed. Provenance attestation is required before public launch. |
| DNS hijack / phishing clone domain | Official domain(s) must be documented, registrar-locked, DNSSEC-enabled where supported by the registrar/TLD, and monitored for record changes. If IPFS/content-addressed hosting is used, an ENS record must point to the pinned deployment. A canonical domain list must be published. |
| TLS/cert mis-issuance | HSTS preload must be enabled on all dapp domains. The required header value `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` is emitted by the Vite preview server via `clients/dapp/src/lib/csp.ts` (`HSTS_HEADER_VALUE`) and verified in CI by `clients/dapp/scripts/check-hsts.sh` (suite-09 "Enforce HSTS preload header" step). Production CDN/nginx operators must copy this directive verbatim. Domain preload-list submission must be completed before public launch via hstspreload.org. |
| XSS in dapp | A Content Security Policy that disallows inline scripts and eval must be enforced. This must be verified in CI before public launch. |
| CSRF on backend signing endpoint | There must be no backend signing endpoint. Signing is client-side or agent-side only. |
| WalletConnect-pairing abuse | Users must be educated on verifying the pairing origin. The dapp must display the connected chain and address prominently before any signing request. |
| Clipboard-swap malware on user device | Users must be educated to verify the full address on their hardware wallet screen before confirming. The dapp must display the full address, not a truncated version, on confirm screens. |
| Permit / Permit2 phishing signature | The dapp must not introduce Permit-based UX without an explicit security review. If Permit is introduced, the signing request must display the full spender, amount, and expiry. |
| `eth_sign` / blind-signing UX | The dapp must use `eth_sendTransaction` or typed data signing only. `eth_sign` is prohibited. All signing requests must display human-readable calldata. The admin tabs ("Create Safe proposal", core 1544) sign only the SafeTx EIP-712 typed data with `eth_signTypedData_v4`, never `eth_sign`, `personal_sign` or raw calldata, after rendering the decoded target, function, args, role effect, Safe, threshold, owners, nonce, timelock, delay, salt and operation id. They refuse before the wallet is asked when the Safe is not canonical SafeL2 v1.4.1, the connected address is not an owner, the Safe lacks `PROPOSER_ROLE`, or the local digest differs from `Safe.getTransactionHash`. The dapp holds no key and runs no signer service. |
| Transaction front-running by RPC provider | The dapp must support private-RPC or commit-reveal for sensitive operations. This is a documented accepted risk for standard deposits until private orderflow is implemented. |

---

## 12. Off-chain — chain & infrastructure

| Attack | Required control |
|---|---|
| Base sequencer censorship | Force-inclusion via L1 must be documented in the user playbook. This is an accepted Base L2 risk. |
| Base sequencer reorg | A minimum confirmation-depth policy must be documented per operation class and enforced by `rmpc` before reporting transaction finality. High-value admin and governance operations must distinguish "L2 included" from "L1 finalized." |
| L1 reorg affecting L2 finality | Same as above. The confirmation-depth policy must account for L1 finality and must be surfaced in `rmpc` JSON output and dapp status copy. |
| RPC provider outage | **Satisfied (issue #667).** `FailoverRpcClient` in `clients/rust-payment-client/src/rpc/mod.rs` retries every JSON-RPC call across an ordered list of endpoints; `Config.rpc_urls` (list) and the backward-compatible `Config.rpc_url` (single) are both accepted. `clients/rust-payment-client/config.example.toml` documents the minimum recommended redundancy (two endpoints from different providers). |
| Mempool-leak exposing pending agent intents | Agent deposits are irreversible by design and carry no slippage surface on the vault leg; public mempool is accepted for MVP. When bucket-B/C legs ship, private orderflow submission must be evaluated. |
| Time/clock skew on signer | Signing must use EVM block context, not wall time, for all deadline and expiry computations. |

---

## 13. Operational — keys, secrets, deployment

| Attack | Required control |
|---|---|
| Deploy-key compromise pushes a malicious contract | Deploy artifacts must match a tagged, reviewed commit. BaseScan verification must complete within one hour of deploy. At least one second reviewer must sign off on the deploy before execution. Deployment runs the `publish-contracts` CLI in this repo, the only deploy driver. The devops repo holds only the mainnet workflow that checks out core and runs it, behind a GitHub Environment with required reviewers (sign-off before execution). On 8453 the CLI accepts that sign-off (`CONFIRM=environment`) only with the job's verified GitHub OIDC token (QA plan v1 B2); any other 8453 run confirms by typing. Its stage 12 verifier checks source verification. |
| Deploy-time protocol agent | The deploy authorizes no gateway agent. An agent belongs to a depositor: the depositor authorizes it through `commitAuthorization` and `revealAuthorization` and owns its policy. The share receiver is always the owner, and no role is exempt. An agent's owner never changes, so no protocol role can be handed an agent (owner decision 2026-10-20). Agent keys hold no admin or pause authority. `DeployGateway.s.sol` reads no `AGENT_*` input and the sheet refuses them. The verifier fails a run whose gateway logged any `AgentAuthorized` up to the handover block, or where any address holds `AGENT_ROLE` when it runs (core 1527). |
| Upgrade release gate | Before a proxied release holds user funds on 8453 (upgradeability stages 2 to 4): the release sheet declares every proxy's mode (`upgradeable` or `frozen`), implementation address and code hash, storage-layout snapshot, timelock and delay, and any proving deadline; `publish-contracts` refuses an undeclared mode (the sheet's `UPGRADE_MODE` has no default, issue 1809); the verifier reads the ERC-1967 slots, `upgradeTimelock()`, `upgradesFrozen()` and the initialized version of every proxy, checks the implementation code and its linked libraries against the build, and records them in `upgradeability.json` and the evidence (issue 1809); signing clients check the live implementation (implemented, issue 1810: every client's implementation pin is updated from the release manifest as part of the upgrade); and the Safe → timelock upgrade and freeze are rehearsed on the Twin fork. A proving-period deadline is an operational commitment, not an automatic freeze: the runbook names the signers who schedule the freeze, and a missed deadline is alerted and reported as upgradeable. |
| Verified-source / deployed-bytecode mismatch | All contracts must be verified on BaseScan. The CI deploy pipeline must assert verification before closing the deploy job. **CI gate implemented** (issue #662): `scripts/assert-basescan-verified.sh` polls the BaseScan `getsourcecode` API for each deployed address and exits non-zero if any contract is unverified when the timeout is reached. |
| Secret leak via repo | `.gitignore` must exclude all `.env`, keystore, and credential files. CI must run a secrets-scanning step on every PR. |
| CI runner compromise injecting deploy artifact | Deploy jobs must run on pinned, hardened runners. Production deploys must require explicit human approval in the CI pipeline. |
| Backup loss / single-keeper-of-seed | Each Safe signer must independently back up their keystore file and passphrase to separate offline media. No single person may hold sole recovery capability. |
| Insider threat (rogue contributor) | `CODEOWNERS` must be configured for `contracts/**` and `scripts/**`. At least two reviewers are required to merge to any branch that can reach production. Branch protection must be enforced on `main` and `dev`. |

---

## 14. Process — audit & institutional memory

| Attack class | Required control |
|---|---|
| Selectively audited surface | An audit-scope ledger must be maintained in `docs/audits.md` mapping every contract to its audit report(s). No contract may ship to production without a completed audit or an explicit documented exception approved by the team. |
| Economic vs. code-only audits (YieldBlox-class) | An economic-model audit is required before any bucket-B/C basket vault enters production. The audit must cover composition logic, oracle assumptions, and rebalancing model. |
| Bug-bounty exclusion of new high-risk contract | A bug-bounty program with a published scope must be live before the public dapp launch. Scope and exclusions must be updated within 72 hours of any new contract deployment. |
| Pattern repetition across deployments | Every audit finding must be cross-referenced against all contracts in the codebase, not only the audited one. The finding register in `docs/audits.md` must include a "checked against" field for each finding. |
| Near-miss dismissal | Any finding that is dismissed rather than fixed must be reviewed by a second team member and logged with an explicit rationale. Dismissed findings must be revisited before any major change to the relevant code path. |
| Disclosure-handling failure | `SECURITY.md` must exist at the repo root with a disclosure address and a maximum response-time commitment. The disclosure address must be monitored with an on-call rotation. |

---

## 15. Out of scope — explicit non-goals

These are deliberately not addressed and will not be addressed under
the current product shape. Listing them here is itself the mitigation:
it prevents a future contributor from assuming we will defend against them.

- Custodial key management for end users (`prd.md` §8).
- Hosted signing services (`prd.md` §8).
- Fiat on/off ramps (`prd.md` §8).
- Direct user calls into Compound/Aave (`prd.md` §8) — concentrating
  flows through the vault is part of the safety story.
- Defending against full multisig-quorum compromise — at that point,
  the protocol has lost its trust anchor by definition.
- Solana-specific attack classes — Robot Money is EVM-only.

Any proposal to remove an item from this list is a significant product
decision and requires explicit approval.

---

## 16. Testing requirements for multisig and admin transactions

Every required control in §4 (access control & admin) must be verified by
automated tests. The following rules apply to all test layers.

### Test layer rules

| Layer | Safe mocking permitted? | Rule |
|---|---|---|
| Forge unit tests | `vm.prank` only | May impersonate the Safe address to test contract-level role enforcement in isolation. Must not use `vm.prank` as a substitute for real Safe quorum verification. |
| Forge fork / integration tests | **No mocking** | Must deploy a real Safe proxy via the canonical `SafeProxyFactory` on the pinned Base mainnet fork. Must assemble the Safe transaction struct, sign with two test private keys using EIP-712, and call `Safe.execTransaction()`. The TimelockController must not be replaced with a stub. |
| rmpc CLI integration tests | **No mocking** | Must run against a devnet where a real Safe proxy holds `PROPOSER_ROLE` and CANCELLER_ROLE on the `TimelockController`. `rmpc get-timelock` output must be validated against on-chain state, including whether EXECUTOR_ROLE is open or Safe-restricted. |
| Dapp e2e (Playwright) | **No mocking** | Must run against the full-stack devnet with a real Safe and TimelockController deployed. |

### Required test coverage for multisig + admin paths

Every test suite that touches `ADMIN_ROLE`, `PROPOSER_ROLE`, CANCELLER_ROLE, or `EXECUTOR_ROLE`
must include all of the following categories:

**Happy paths (must pass for every governed contract, the nine in architecture §4.5)**
- Full round-trip: Safe quorum met → `TimelockController.schedule()` → delay elapsed → `TimelockController.execute()` → ADMIN_ROLE operation applied
- `rmpc get-timelock` returns correct proposers, cancellers, executor policy, min delay, and pending operation after scheduling
- Open executor, if configured: a non-Safe address can execute a ready operation after the delay but cannot schedule or cancel it

**Sad paths (must revert with the expected error)**
- Quorum not met: one signature from the 2-of-N Safe reverts inside `Safe.execTransaction()` before reaching the timelock
- Wrong signers: two signatures from addresses not in the Safe owner set revert
- Pre-delay execute: `TimelockController.execute()` before min delay elapses reverts
- Replay: re-executing an already-executed operation reverts
- Cancellation: a cancelled operation cannot be executed
- Direct bypass: calling a governed contract ADMIN_ROLE function directly (not through Safe + timelock) reverts with `AccessControlUnauthorizedAccount`
- Unauthorized schedule/cancel: an address without Safe quorum cannot schedule or cancel an operation

**Deploy-time assertions (must fail fast)**
- `DeployTimelock.s.sol` must revert with a descriptive error when any configured Safe address has no deployed code
- `DeployTimelock.s.sol` must revert with a descriptive error when any configured Safe has `getThreshold() < 2`
- `DeployTimelock.s.sol` must emit or record whether EXECUTOR_ROLE is open (`address(0)`) or Safe-restricted

### Safe infrastructure

Fork and integration tests must use the canonical Safe infrastructure already
deployed on Base mainnet — do not redeploy the Safe singleton. The
`SafeProxyFactory` at `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` (Safe
v1.4.1) is present on the Base fork and must be used to create test Safe
proxies. Test keys are ephemeral and generated per test run; production keys
are never used in tests.

### Minimum test count

The combined Safe + TimelockController test surface must comprise at least
30 distinct test cases across Forge unit, Forge fork, and rmpc integration
layers. Test count is a floor, not a target — every meaningful path must be
covered regardless of count.

---

## 17. Revision policy

Update this document when any of the following change:

- A new contract or adapter ships.
- A new chain or bridge is added.
- The dapp or any frontend hosting model changes.
- An audit completes (link the report from §14).
- A new attack class is published that is not yet listed here.
- A required control is strengthened, relaxed, or replaced.

Pair-review changes to §15 (out-of-scope) — moving an item out of
scope is a significant product decision.

Any PR that weakens a required control in this document must include
an explicit rationale and must be approved by at least two team
members.
