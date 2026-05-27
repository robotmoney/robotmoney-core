# Robot Money — Security Model

> Scope: an exhaustive taxonomy of web, web3, and blockchain attacks
> against Robot Money, with the required control for each. This document
> is a **security specification** — it states what must be true, not
> what has been built. Every row is a requirement that must hold at
> production launch and remain true across all future changes.
>
> This document is canonical for the security posture. Threat tables
> in `docs/architecture.md` §15 and `docs/technical/smart-contracts.md`
> §5 are summaries that link here. Public-facing risk research lives
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
- autonomous-agent loss is bounded on-chain for both deposits and
  withdrawals;
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

---

## 2. Smart contract — execution & state ordering

| Attack | Required control |
|---|---|
| Classic single-function reentrancy | OZ `ReentrancyGuard` must protect every external state-mutating function that moves assets or calls an external contract in the vault, gateway, and Portfolio Router, including vault deposit/withdraw/rebalance/emergency paths, `RobotMoneyGateway.deposit`, `depositTo`, `withdraw`, and router deposit paths. New external mutating functions must be reviewed for reentrancy before merge. |
| Cross-function reentrancy | A single `ReentrancyGuard` instance must cover all asset-moving external state-mutating paths on each contract. Effects must be written before external calls, residual allowances must be cleared after one-shot use, and post-call custody invariants must be checked on every path that temporarily holds USDC or receipt tokens. |
| Read-only reentrancy (oracle/share-price during callback) | All adapter call paths that read balances of external contracts must be enumerated and verified to be free of callback surfaces that could be queried mid-state. This analysis must be published and kept current as adapters are added. |
| ERC-721/1155 callback reentrancy | Vault contracts must not implement `onERC721Received` or `onERC1155Received`. The vault must hold only USDC and adapter receipt tokens. |
| Compiler-level reentrancy bugs | Contracts must use Solidity ≥0.8 and OZ `ReentrancyGuard`. The Vyper `@nonreentrant` regression does not apply; this constraint must be re-evaluated if the toolchain changes. |
| Integer overflow / underflow | All arithmetic must use Solidity ≥0.8 checked arithmetic. `unchecked` blocks are prohibited in any code path that touches user balances, shares, fees, or caps. |
| Unsafe casting | Narrowing casts (`uint256` → smaller type) are prohibited in user-facing code paths. All casts must be reviewed for overflow at the point of introduction. |
| Storage collision via upgradeable proxies | All contracts must be direct non-proxy deployments. Upgradeable proxy patterns are prohibited. |
| Self-destruct / `SELFDESTRUCT` ejection | No `selfdestruct` or `CREATE2`-replace pattern may be present in any contract. Post-Cancun semantics reduce this risk but the prohibition stands. |
| Delegatecall to attacker-controlled target | `delegatecall` is prohibited in vault and adapter contracts. Any future use must be reviewed explicitly and justified in the PR. |
| Adapter codehash allowlist bypass via delegatecall proxy | Approved RobotMoneyVault strategy adapters must be direct (non-proxy) deployments whose runtime bytecode contains no `DELEGATECALL` opcode (`0xF4`). This is enforced at deploy time by `AdapterBytecodeGuard.requireNoDelegatecall` in `contracts/script/Deploy.s.sol::_approveAdapter` and regression-tested in `contracts/test/AdapterDelegatecallGuard.t.sol` against every currently approved adapter (Aave V3, Compound V3, Morpho, Passthrough). Any future proxy-pattern adapter must instead pin both proxy and implementation codehashes in the allowlist, and the policy update must ship in the same PR. |
| Uninitialized storage / proxy initializer | Contracts must use constructors only. Initializer patterns are prohibited. |
| Recursive self-liquidation (Euler-class) | No lending or liquidation logic may be present in the vault. This constraint must be re-evaluated if the product shape changes. |

---

## 3. Smart contract — accounting & supply

| Attack | Required control |
|---|---|
| ERC-4626 inflation / first-depositor share-price attack | `RobotMoneyVault._decimalsOffset()` must return `18`, configuring OZ virtual shares to `10^18`. The deploy runbook must require a seed deposit of ≥ 1,000 USDC before the vault is opened to the public. This must be verified in CI fork tests. |
| Donation-to-reserves bypass (Euler/Venus class) | `totalAssets()` must be defined and documented to prevent direct ERC-20 transfer manipulation. The accounting model must be published and verified via fork tests that show a large direct USDC donation does not materially advantage a subsequent depositor. |
| Supply-cap bypass via direct transfer | `tvlCap` must be enforced on the deposit path. `totalAssets()` accounting must be shown to not allow a direct-transfer-inflated cap bypass. |
| Per-deposit-cap bypass via splitting | `perDepositCap` is per-call by design for rate-shaping, not anti-Sybil. This is an accepted limitation; it must be documented in the public risk disclosure. |
| Exit-fee evasion via flash loan | `MAX_EXIT_FEE_BPS` must be an `immutable` ceiling. No in-protocol primitive may allow bypassing the fee. |
| Fee accrual rounding | `previewWithdraw` and `previewRedeem` must round consistently in favor of the vault. A published rounding analysis must confirm no dust-siphon path exists. |
| Withdrawal-routing griefing | The withdrawal path must cap partial pulls at the available adapter balance. `forceRemoveAdapter` must accept explicit loss write-off. |
| Stuck-token / fund recovery abuse | `rescueTokens` must reject `asset()` and `address(this)` on the vault. Adapter `rescueTokens` must reject USDC and the protocol receipt token. |

---

## 4. Smart contract — access control & admin

| Attack | Required control |
|---|---|
| Single-EOA admin compromise | No EOA may hold `ADMIN_ROLE` directly on any contract. `ADMIN_ROLE` must be held exclusively by the `TimelockController`. Agent and keeper roles must be separated from `ADMIN_ROLE`. |
| PROPOSER_ROLE held by a plain EOA | The `TimelockController` PROPOSER_ROLE and CANCELLER_ROLE must be held by a Safe multisig with a minimum threshold of 2-of-N signers. EXECUTOR_ROLE should be open (`address(0)`) so any address can execute an already-delayed, already-authorized operation after the delay; if a restricted executor is used, it must be a Safe with threshold ≥ 2 and the liveness tradeoff must be documented. `DeployTimelock.s.sol` must verify at deploy time that every Safe address has deployed code and `getThreshold() >= 2`. The Safe address, threshold, executor policy, and canceller policy must be recorded in this document at deploy time. |
| `ADMIN_ROLE` self-grant escalation | `ADMIN_ROLE` is its own admin by design. All role changes must route through the `TimelockController`. The Safe multisig must enforce quorum independently. |
| Timelock bypass | A `TimelockController` must hold `ADMIN_ROLE` on all governed contracts. The production delay for high-risk operations must be ≥ 48 hours; any lower-delay operation class must be explicitly enumerated with its rationale, maximum authority, and affected functions. Admin operations must route through `schedule → delay → execute`; direct `ADMIN_ROLE` calls from any address must revert with `AccessControlUnauthorizedAccount`. The deployed timelock address, min delay, proposers, executors, cancellers, pending operations, and operation salts must be verifiable via `rmpc get-timelock` and the dapp timelock panel. |
| Pause-key abuse (denial of deposit) | The pause role must be separable from `ADMIN_ROLE`. Pause must halt deposits but must not be able to move funds. The pause role should be held by a lower-quorum guardian to allow fast response; the unpause role must require `ADMIN_ROLE` through the timelock. |
| Emergency-role abuse to drain | `EMERGENCY_ROLE` must return funds to the vault only, never to an attacker-chosen address. `emergencyWithdraw` must use `try/catch` per adapter to prevent a single bad adapter from blocking recovery. |
| Fee parameter manipulation above ceiling | `MAX_EXIT_FEE_BPS` must be `immutable`. `setExitFeeBps` must revert above this ceiling. |
| Rebalance-throttle removal | Rebalance interval floor and bps ceiling must be `immutable` constants. Admin must not be able to remove these constraints. |
| Fee-recipient swap to attacker address | `setFeeRecipient` must be admin-gated and routed through the timelock. The fee recipient must be verified to be a non-zero address. |
| Multisig social engineering (Drift-class) | A signer playbook must be published and followed. Signers must independently simulate the operation before approving, review the calldata diff against the expected effect, and meet a minimum deliberation time. No signer may approve on the same device as the proposer. |
| Signer-device compromise | All Safe signers must use hardware wallets. Software key signing is prohibited for any `ADMIN_ROLE` or `PROPOSER_ROLE` operation. |
| Role separation drift | At deploy and at every admin operation, an off-chain assertion must confirm that admin, pause, emergency, agent, proposer, canceller, and executor authorities satisfy their documented separation rules. No account may hold more than one of gateway `ADMIN_ROLE`, `PAUSER_ROLE`, or `AGENT_ROLE`. |

---

## 5. Smart contract — oracle & pricing

| Attack | Required control |
|---|---|
| Spot-price manipulation via flash loan (Harvest-class) | The vault must not consume DEX spot prices. Share price must equal `totalAssets() / totalSupply()` against per-adapter accounting only. Any future adapter that consumes a price source must document the oracle and its manipulation resistance. |
| TWAP / VWAP poisoning | No TWAP or VWAP may be consumed by any vault unless a manipulation-resistance analysis is published, a minimum TWAP window is specified, and a circuit breaker is in place. |
| Stale-price oracle | Adapters that depend on upstream oracles (Compound v3, Aave v3) must document the oracle freshness requirement and the upstream circuit-breaker behavior. This is an accepted upstream-trust assumption. |
| Single-source oracle | Any adapter that introduces a new price source must use at least two independent oracle sources or a TWAP with documented staleness tolerance. |
| Dead-market pricing without circuit breaker (YieldBlox-class) | Accepted as an upstream venue risk for Compound v3 and Aave v3. A monitoring alert must exist for each venue going offline. |
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
- **Circuit breaker.** `pause()` (EMERGENCY_ROLE) suspends deposits and
  withdrawals; `shutdownVault()` zeroes the TVL cap. Both remain available
  if a TWAP-derived NAV starts looking anomalous.
- **Single-source disclosure.** BasketVault currently relies on a single
  Uniswap V3 pool per asset. The TWAP window is the documented
  manipulation-resistance control; production deployments that require a
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
| Flash-loan voting takeover (Beanstalk-class) | When `$ROBOTMONEY` / `veRM` governance ships, vote weight must be determined by a snapshotted or vote-escrowed balance, not a spot balance. Flash-loan acquisition of voting power must be provably ineffective. |
| Same-block propose-and-execute | All governance execution must include a mandatory delay between proposal and execution. This applies to both the `TimelockController` and any future token-governance module. |
| Bribery / vote-buying markets | Acknowledged risk class. The governance design must document its stance on vote markets before the governance token ships. |
| Treasury drain via malicious proposal | Treasury operations must be gated by the multisig-backed timelock. A treasury-drain proposal must be detectable and cancellable within the timelock delay window. |
| Admin-weighted MVP vote capture | The current RouterGovernance module uses admin-assigned voting power. Until token-holder voting ships, voting-power assignment, quorum changes, voting-period changes, execution-delay changes, and proposal creation must be treated as privileged configuration and routed through the admin timelock. Ordinary vote casting and post-vote execution follow RouterGovernance's own voting period and execution delay; they must not grant authority over vault internals, fees, adapters, or agent policies. |
| Router-weight governance parameter whiplash | Quorum threshold, voting period, execution delay, and fallback behavior must be bounded by immutable or timelocked minimums before mainnet scale. The dapp and `rmpc get-governance` must surface the active parameters before any vote or weight execution. |
| MEV sandwich on rebalance | `rebalance()` must enforce a throttle (minimum interval, maximum bps per call). Large rebalances must use private orderflow or commit-reveal to prevent sandwich extraction. The acceptable sandwich loss threshold must be documented. |
| MEV sandwich on user deposit/withdraw | Vault deposits and withdrawals must move USDC ↔ shares at internally computed ratios with no DEX slippage surface. Any future bucket-B/C leg that touches DEX liquidity must specify and enforce a slippage bound. |
| JIT liquidity / inspection-and-front-run | The share-price computation must not expose a profitable front-run surface. This must be verified in the economic-model audit before bucket-B/C ships. |

---

## 8. Smart contract — dependency & legacy code

| Attack | Required control |
|---|---|
| Pre-0.8 integer overflow inheritance | All contracts must use Solidity ≥0.8. OZ dependency versions must be pinned in `foundry.toml` / `package.json`. Any dependency upgrade requires a PR with an explicit compatibility review. |
| Unverified bytecode | All production contracts must be verified on BaseScan within one hour of deployment. The verified source must match the tagged commit in this repository. |
| Compromised npm/cargo dependency | `cargo audit`, npm/Bun dependency audit, and lockfile-integrity checks must run in CI and block on high-severity findings. Solidity, Rust, JS, and GitHub Actions dependencies must be pinned to exact versions or immutable SHAs. Any dependency update requires an explicit review comment in the PR. |
| Compiler-bug exposure | Before each production deployment, the Solidity known-bug list for the compiler version in use must be reviewed and any applicable bugs documented and addressed. |
| Adapter target contract upgrade | Compound v3 and Aave v3 are upgradeable by their own governance. This is an accepted upstream-trust assumption. A monitoring process must alert on upstream governance proposals that affect our adapter interfaces. |
| Token-rebase or fee-on-transfer upstream change | USDC is upgradeable by Circle. A monitoring process must alert on Circle upgrade proposals. The vault must have a documented pause-and-review procedure if USDC semantics change. |

---

## 9. Smart contract — circuit breakers & monitoring

| Attack | Required control |
|---|---|
| No anomaly detection on mint/burn rate | An automated watchdog must monitor per-block and per-hour mint and burn volume against defined thresholds. Breach must trigger an automated pause or alert to an on-call operator with a maximum response-time SLA. |
| Manual incident response too slow | On-chain events (cap saturation, large single deposits, adapter balance deviations) must feed an automated alert system. The on-call rotation and escalation path must be documented. |
| Pause-trigger key not pre-positioned | A guardian role with lower quorum than the full Safe must be able to pause without going through the timelock. This guardian may not unpause; that requires `ADMIN_ROLE` through the timelock. |
| Missing on-chain kill switch for adapter | `forceRemoveAdapter` must exist with explicit loss-acceptance semantics. Every adapter deployment must confirm this path is exercised in tests. |
| Dismissed audit finding later exploited (Venus-class) | Every audit finding must be logged in `docs/audits.md` with a disposition: fixed, accepted-with-rationale, or dismissed-with-rationale. Dismissed findings must be reviewed before any major change that touches the relevant code path. |

---

## 10. Off-chain — agent access layer (`rmpc` and gateway)

This section maps onto `docs/architecture.md` §15.

| Attack | Required control |
|---|---|
| Prompt injection of agent planner causing unsafe asset movement | The planner must not be able to sign. The gateway must enforce role, amount/share caps, destination/source allowlists, deadline, idempotency, share receiver, asset recipient, and pause state independently of any agent-side state. `rmpc` must verify chain id, runtime code hash, and configured addresses before building calldata. |
| Agent key exposure | Agent keys must be constrained to gateway `AGENT_ROLE` paths only. Loss budget must equal the configured deposit cap plus the configured withdrawal share cap and any receipt-token allowance the depositor deliberately grants to the gateway, not total vault assets. The withdrawal cap MUST be enforced as a strict rolling window so the loss budget equals the configured per-window cap (no boundary-burst inflation). Withdrawn USDC must be sent only to the depositor-configured asset recipient. |
| Client host compromise | The signer API must be narrow and accept only known calldata shapes for gateway deposits, routed deposits, withdrawals, policy reads, and approved admin/operator commands. On-chain caps, allowlists, recipients, and deadlines are the backstop regardless of client state. |
| Local state rollback | Idempotency keys, cap usage, policy expiry, destination/source allowlists, share receiver, and asset recipient must be enforced on-chain, not in local state. |
| Malicious or stale RPC | `rmpc` must verify chain-id and gateway code hash on every operation. Multi-RPC comparison must be supported for high-value operations. |
| Software-key extraction | HSM, KMS, Secure Enclave, or TPM is the required signing backend for production. Software key signing must require an explicit opt-in flag and must be prohibited in production config. |
| Pause abuse via agent role | The agent role must not be able to trigger pause. Role separation must be enforced at the contract level, not by convention. |
| Fixed-window boundary burst | Withdrawal-cap accounting MUST use a rolling-window accumulator: the cumulative shares redeemed in any `WINDOW_SECONDS`-wide interval are bounded by `maxWithdrawPerWindow`. The on-chain anchor advances to `block.timestamp` only after a full `WINDOW_SECONDS` has elapsed since the last withdrawal, eliminating the calendar-boundary ~2x burst that fixed windows permit. Deposit-cap windows MAY remain calendar-aligned because the deposit loss budget is bounded by the depositor's USDC allowance, not the per-window cap. |
| Replay of signed transaction across chains | Chain-id check must be present in `rmpc` and enforced by EIP-155 signing. |
| Replay within chain (nonce reuse) | Per-agent nonce file lock must prevent concurrent invocation. `ErrConcurrentInvocation` must be the documented error path. |
| Race between concurrent agent tasks | The nonce lock must be the single serialization point. No other coordination mechanism should be introduced without an explicit ADR. |
| Idempotency domain collision | Gateway idempotency identifiers must domain-separate operation kind (`deposit`, `depositTo`, `withdraw`), chain id, gateway address, agent, order id, amount/shares, destination/source, receiver/recipient, and caller-provided idempotency key. A routed deposit and a withdrawal must never be able to consume each other's idempotency namespace. |
| Agent withdrawal redirect | Gateway-mediated withdrawals must verify source vault, receipt allowance, receipt balance, max shares per payment, max shares per window, previewed minimum assets out, deadline, and policy-configured asset recipient before signing and before execution. The agent must never choose the USDC recipient at execution time. |
| Receipt-token allowance overhang | Dapp and `rmpc` must display current gateway receipt-token allowance and recommend bounded allowances aligned with the policy withdrawal cap. Revoking an agent policy must be paired in the UI/runbook with revoking any receipt-token allowance that could otherwise be reused if the agent is re-authorized. |
| Signer-backend MITM | Trust collapses to the signer device. Hardware signer attestation is the accepted mitigation. |

---

## 11. Off-chain — dapp / frontend / web2

| Attack | Required control |
|---|---|
| Frontend JS injection (Bybit/Safe-class) | The dapp must be deployed with a strict Content Security Policy that disallows inline scripts and eval. Public production builds must be static, content-addressed or content-hash deployed, and reproducible from a signed tag. Third-party or CDN scripts are prohibited by default; if an exception is approved, Subresource Integrity hashes are required. The canonical deployment procedure must be documented and enforced. |
| Build-pipeline compromise | Dapp release artifacts must be reproducibly buildable from a tagged commit. Release tags must be signed. Provenance attestation is required before public launch. |
| DNS hijack / phishing clone domain | Official domain(s) must be documented, registrar-locked, DNSSEC-enabled where supported by the registrar/TLD, and monitored for record changes. If IPFS/content-addressed hosting is used, an ENS record must point to the pinned deployment. A canonical domain list must be published. |
| TLS/cert mis-issuance | HSTS preload must be enabled on all dapp domains. |
| XSS in dapp | A Content Security Policy that disallows inline scripts and eval must be enforced. This must be verified in CI before public launch. |
| CSRF on backend signing endpoint | There must be no backend signing endpoint. Signing is client-side or agent-side only. |
| WalletConnect-pairing abuse | Users must be educated on verifying the pairing origin. The dapp must display the connected chain and address prominently before any signing request. |
| Clipboard-swap malware on user device | Users must be educated to verify the full address on their hardware wallet screen before confirming. The dapp must display the full address, not a truncated version, on confirm screens. |
| Permit / Permit2 phishing signature | The dapp must not introduce Permit-based UX without an explicit security review. If Permit is introduced, the signing request must display the full spender, amount, and expiry. |
| `eth_sign` / blind-signing UX | The dapp must use `eth_sendTransaction` or typed data signing only. `eth_sign` is prohibited. All signing requests must display human-readable calldata. |
| Transaction front-running by RPC provider | The dapp must support private-RPC or commit-reveal for sensitive operations. This is a documented accepted risk for standard deposits until private orderflow is implemented. |

---

## 12. Off-chain — chain & infrastructure

| Attack | Required control |
|---|---|
| Base sequencer censorship | Force-inclusion via L1 must be documented in the user playbook. This is an accepted Base L2 risk. |
| Base sequencer reorg | A minimum confirmation-depth policy must be documented per operation class and enforced by `rmpc` before reporting transaction finality. High-value admin and governance operations must distinguish "L2 included" from "L1 finalized." |
| L1 reorg affecting L2 finality | Same as above. The confirmation-depth policy must account for L1 finality and must be surfaced in `rmpc` JSON output and dapp status copy. |
| RPC provider outage | `rmpc` must support multiple RPC endpoints with automatic failover. The operator config must document the required redundancy. |
| Mempool-leak exposing pending agent intents | Agent deposits are irreversible by design and carry no slippage surface on the vault leg; public mempool is accepted for MVP. When bucket-B/C legs ship, private orderflow submission must be evaluated. |
| Time/clock skew on signer | Signing must use EVM block context, not wall time, for all deadline and expiry computations. |

---

## 13. Operational — keys, secrets, deployment

| Attack | Required control |
|---|---|
| Deploy-key compromise pushes a malicious contract | Deploy artifacts must match a tagged, reviewed commit. BaseScan verification must complete within one hour of deploy. At least one second reviewer must sign off on the deploy before execution. |
| Verified-source / deployed-bytecode mismatch | All contracts must be verified on BaseScan. The CI deploy pipeline must assert verification before closing the deploy job. |
| Secret leak via repo | `.gitignore` must exclude all `.env`, keystore, and credential files. CI must run a secrets-scanning step on every PR. |
| CI runner compromise injecting deploy artifact | Deploy jobs must run on pinned, hardened runners. Production deploys must require explicit human approval in the CI pipeline. |
| Backup loss / single-keeper-of-seed | Each Safe signer must independently back up their seed phrase to an offline, hardware-encrypted medium. No single person may hold sole recovery capability. |
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

**Happy paths (must pass for all five governed contracts)**
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
