# Robot Money — Security Model

> Scope: an exhaustive taxonomy of web, web3, and blockchain attacks
> against Robot Money, with an honest assessment of each. Every row
> is one of: **Mitigated** (addressed in shipped code/config),
> **Planned** (called out in `docs/implementation-plan.md` or
> `docs/architecture.md`), **Inherited** (risk passes through to an
> upstream protocol — USDC, Compound v3, Aave v3, Base sequencer),
> **Out-of-scope** (deliberate architectural exclusion),
> **Unaddressed** (a real gap that should be triaged), or **N/A**
> (does not apply to our chain or product shape).
>
> This document is canonical for the security posture. Threat tables
> in `docs/architecture.md` §15 and `docs/technical/smart-contracts.md`
> §5 are summaries that link here. Public-facing risk research lives
> at <https://www.robotmoney.net/smart-contract-risks>; this document
> is the internal counterpart that maps that taxonomy onto our code
> and roadmap.
>
> Code references point to files in `contracts/` at this repo root.
> Adapter risk inherits from Compound v3 and Aave v3 deployments on
> Base; we do not re-audit upstream code.

## 1. How to read this document

Each section is one attack family. Each row is one specific attack
within that family. The **Status** column states our posture today;
the **Notes / evidence** column gives the file, function, or roadmap
item that justifies the status. When the status is **Unaddressed**
the notes describe what triage would look like.

Statuses are not promises. A row marked **Mitigated** describes
mitigations *as deployed today*; nothing here is an audit
attestation.

---

## 2. Smart contract — execution & state ordering

| Attack | Status | Notes / evidence |
|---|---|---|
| Classic single-function reentrancy | Mitigated | `nonReentrant` on `_deposit`, `_withdraw`, `rebalance`, `adminRebalance`, `emergencyWithdraw`, `emergencyWithdrawAdapter` (`contracts/RobotMoneyVault.sol`) |
| Cross-function reentrancy | Mitigated | Single `ReentrancyGuard` instance covers all external state-mutating paths; balance reads occur after CEI ordering in adapters |
| Read-only reentrancy (oracle/share-price during callback) | Unaddressed | No analysis published. ERC-4626 `convertToAssets` reads live adapter balances; if any future adapter exposes a callback during balance reporting it could be queried mid-state. Triage: enumerate adapter call paths that read balances of contracts capable of reentrant callbacks |
| ERC-721/1155 callback reentrancy (`onERC*Received`) | N/A | Vault holds only USDC and adapter receipt tokens; no NFT or 1155 surface |
| Compiler-level reentrancy bugs (e.g., Vyper `@nonreentrant` regression) | Mitigated | Solidity 0.8.24, OpenZeppelin `ReentrancyGuard` — does not share the affected toolchain |
| Integer overflow / underflow | Mitigated | Solidity ≥0.8 checked arithmetic; no `unchecked` blocks in vault accounting |
| Unsafe casting (`uint256` → `uint128` etc.) | Mitigated | Vault stores caps and bps as `uint256`/`uint16` without narrowing casts in user paths; verify per-PR |
| Storage collision via upgradeable proxies | N/A | All four contracts are direct, non-proxy deployments (`smart-contracts.md` §5) |
| Self-destruct / `SELFDESTRUCT` ejection | Mitigated | No `selfdestruct` in our contracts. Post-Cancun, `SELFDESTRUCT` no longer deletes code, so this is largely historical |
| Delegatecall to attacker-controlled target | Mitigated | No `delegatecall` in vault or adapters |
| Uninitialized storage / proxy initializer | N/A | No proxies, no initializers — constructors only |
| Recursive self-liquidation (Euler-class) | N/A | No lending or liquidation logic in the vault |

---

## 3. Smart contract — accounting & supply

| Attack | Status | Notes / evidence |
|---|---|---|
| ERC-4626 inflation / first-depositor share-price attack | Mitigated | `RobotMoneyVault._decimalsOffset()` returns `18`, configuring OZ virtual shares to `10^18`. This makes donation-based price manipulation require donating >10^18× the virtual floor — economically infeasible. Additionally, the deploy runbook (see `Deploy.s.sol` comments and `docs/technical/smart-contracts.md`) requires an admin seed deposit of ≥ 1,000 USDC before opening the vault to the public. Tests in `contracts/test/RobotMoneyVault.t.sol` prove the raw-share scale and verify that a 1 M USDC adapter-level donation cannot force a realistic victim deposit to mint zero or materially unfair shares. |
| Donation-to-reserves bypass (Euler/Venus class) | Unaddressed | A direct ERC-20 transfer of USDC to the vault inflates `totalAssets()` without minting shares. If the vault later accounts donations as yield, the next depositor pays a worse price; if as profit, a prior depositor is over-credited. Triage: trace `totalAssets()` definition and confirm it does not allow direct-transfer manipulation |
| Supply-cap bypass via direct transfer | Mitigated | `tvlCap` is enforced on the deposit path. Direct transfers do not mint shares, so they cannot exceed cap-by-share. They can still inflate `totalAssets()` — see donation row above |
| Per-deposit-cap bypass via splitting | Out-of-scope | `perDepositCap` is per-call, not per-address. The intent is rate-shaping, not anti-Sybil; called out in the original design |
| Exit-fee evasion via flash loan | Mitigated | `MAX_EXIT_FEE_BPS = 100` (1% immutable ceiling). Even at the maximum, the fee applies on every exit; no in-protocol primitive lets an attacker skip it |
| Fee accrual rounding (siphon dust) | Unaddressed | OZ ERC-4626 rounds in favor of the vault on conversions. No published rounding analysis on our exit-fee path. Triage: prove `previewWithdraw` / `previewRedeem` round consistently |
| Withdrawal-routing griefing (proportional pull picks empty adapter) | Mitigated | Partial pull caps at available balance; `forceRemoveAdapter` accepts write-off (`smart-contracts.md` §5) |
| Stuck-token / fund recovery escape hatch abuse | Mitigated | `rescueTokens` rejects `asset()` and `address(this)` on the vault; adapter `rescueTokens` rejects USDC and the protocol receipt token |

---

## 4. Smart contract — access control & admin

| Attack | Status | Notes / evidence |
|---|---|---|
| Single-EOA admin compromise | Mitigated | Production `ADMIN_ROLE` is the Safe multisig `0x88bA…75A0`; agent and keeper roles are separated |
| `ADMIN_ROLE` self-grant escalation | Mitigated | `ADMIN_ROLE` is its own admin by design; the trust assumption is that the multisig honors its own quorum (`smart-contracts.md` §3.4) |
| Pause-key abuse (denial of deposit) | Mitigated | Documented residual risk: pause halts deposits but cannot move funds. Pause role separable from admin role (`architecture.md` §15) |
| Emergency-role abuse to drain | Mitigated | `EMERGENCY_ROLE` returns funds to the vault, not to an attacker-chosen address; `emergencyWithdraw` uses `try/catch` per adapter |
| Fee parameter manipulation above ceiling | Mitigated | `MAX_EXIT_FEE_BPS = 100` is `immutable`; `setExitFeeBps` reverts above this |
| Rebalance-throttle removal | Mitigated | `MIN_REBALANCE_INTERVAL_FLOOR = 1 hour` and `MAX_REBALANCE_BPS_CEILING = 5000` are immutable floors/ceilings |
| Fee-recipient swap to attacker address | Inherited | `setFeeRecipient` is admin-gated; trust collapses to multisig integrity |
| Multisig social engineering (Drift-class, pre-signing under false pretenses) | Unaddressed | No documented operational policy for what signers must verify before approving. Triage: publish a signer playbook (calldata diff review, simulation requirement, per-signer independent verification, time-on-screen minimum) |
| Signer-device compromise | Inherited | Hardware-wallet recommendation in `architecture.md` §15. Operational, not a code mitigation |
| Timelock bypass | Out-of-scope | No timelock today. Acceptable while admin surface is small and exit fee is capped at 1%. Revisit when bucket-B/C governance lands |
| Role separation drift over time | Unaddressed | No on-chain assertion that pause and admin keys differ. Triage: monitor or attest at deploy/configure time |

---

## 5. Smart contract — oracle & pricing

| Attack | Status | Notes / evidence |
|---|---|---|
| Spot-price manipulation via flash loan (Harvest-class) | N/A | The vault does not consume DEX prices. Share price = `totalAssets() / totalSupply()` against per-adapter accounting |
| TWAP / VWAP poisoning | N/A | No TWAP/VWAP consumed by the vault |
| Stale-price oracle | Inherited | Compound v3 and Aave v3 each consume their own oracles; their staleness/health checks are upstream |
| Single-source oracle | Inherited | Same as above |
| Dead-market pricing without circuit breaker (YieldBlox-class) | Inherited | Upstream venue concern |
| Cross-chain oracle desync | N/A | Single chain (Base) today |

---

## 6. Smart contract — cross-chain & bridges

| Attack | Status | Notes / evidence |
|---|---|---|
| Weak DVN / verifier configuration (Kelp-class) | N/A | No bridge or message-passing layer in scope today |
| Compromised relayer / verifier signing | N/A | Same |
| Replay across chains (no chain id binding) | Mitigated | `architecture.md` §15 requires chain-id check in `rmpc`; on-chain calls are EIP-155 by default |
| Message ordering / reorg-induced double-spend | Inherited | Base sequencer / L2 reorg risk; out of our control |
| Bridge-locked-funds custody risk | N/A | We do not bridge user funds |

When multi-chain is introduced (post-MVP per `project-roadmap.md`),
this section must be re-scored before any bridge integration ships.

---

## 7. Smart contract — economic & governance

| Attack | Status | Notes / evidence |
|---|---|---|
| Flash-loan voting takeover (Beanstalk-class) | Planned | Phase-4 protocol has no governance token. When `$ROBOTMONEY` / `veRM` ships (`project-roadmap.md`), vote-escrow / snapshot-with-checkpoint is required |
| Same-block propose-and-execute | Planned | Same — must include execution delay |
| Bribery / vote-buying markets | Planned | Acknowledged risk class; out of MVP scope |
| Treasury drain via malicious proposal | Planned | Mitigated by multisig-bounded execution path described in `prd.md` §7 |
| MEV sandwich on rebalance | Unaddressed | `rebalance()` is throttled (1h floor, 50% bps ceiling) but is observable in the mempool. Triage: estimate worst-case sandwich against current adapter set; consider private-orderflow submission for large rebalances |
| MEV sandwich on user deposit/withdraw | Mitigated | Vault deposits/withdraws move USDC ↔ shares at internally computed ratios; no slippage surface for a sandwich on the vault leg. Bucket-B/C legs (future) will need slippage bounds — already promised in `prd.md` §7 |
| JIT liquidity / inspection-and-front-run | Inherited | Upstream Compound/Aave concern |
| Just-in-time first-depositor share manipulation | Unaddressed | See ERC-4626 inflation row in §3 |

---

## 8. Smart contract — dependency & legacy code

| Attack | Status | Notes / evidence |
|---|---|---|
| Pre-0.8 integer overflow inheritance | Mitigated | All four contracts are 0.8.24; OZ versions pinned |
| Unverified bytecode / "relic hunter" target | Mitigated | All four contracts verified on BaseScan |
| Compromised npm/cargo dependency (lockfile injection) | Unaddressed | No published policy on lockfile auditing or dependency review cadence for contracts repo or `rmpc`. Triage: enable `cargo audit` and a Solidity dependency pinning check in CI |
| Compiler-bug exposure (Solidity known-bug list) | Unaddressed | No documented mapping of 0.8.24 known-bugs to our code paths. Triage: cross-reference Solidity bug list, flag any matches |
| Adapter target contract upgrade changes semantics | Inherited | Compound v3 and Aave v3 are upgradeable by their own admins. Listed as an accepted upstream-trust assumption |
| Token-rebase or fee-on-transfer upstream change | Unaddressed | USDC is not rebasing today, but is upgradeable by Circle. `architecture.md` §15 lists "USDC issuer action" as monitor-and-pause |

---

## 9. Smart contract — circuit breakers & monitoring

| Attack | Status | Notes / evidence |
|---|---|---|
| No anomaly detection on mint/burn rate | Unaddressed | Caps exist, but no per-block or per-hour mint volume threshold and no automated pause trigger. Triage: define a watchdog (off-chain or guardian role) with documented thresholds |
| Manual incident response too slow | Unaddressed | Implicit reliance on humans to notice. Triage: subscribe to events and alert on cap-saturation, large single deposits, adapter balance deviations |
| Pause-trigger key not pre-positioned | Unaddressed | The Safe multisig holds pause; quorum may take hours. Triage: consider a separate, lower-quorum guardian role that can pause but not unpause |
| Missing on-chain "kill switch" for adapter | Mitigated | `forceRemoveAdapter` exists with explicit loss acceptance |
| Audit finding dismissed and later exploited (Venus-class) | Unaddressed | No documented register of dismissed audit findings. Triage: track every audit finding with disposition (fixed / accepted / dismissed) and revisit "dismissed" entries before each major change |

---

## 10. Off-chain — agent access layer (`rmpc` and gateway)

This section maps onto `docs/architecture.md` §15. We restate it
here to avoid drift.

| Attack | Status | Notes / evidence |
|---|---|---|
| Prompt injection of agent planner causing unsafe deposit | Mitigated | Planner cannot sign; gateway enforces role, caps, code hash, amount, deadline, receiver policy |
| Agent key exposure | Mitigated | Agent key constrained to `AGENT_ROLE` deposit path; loss budget = configured per-window cap |
| Client host compromise | Mitigated | Narrow signer API; known calldata only; on-chain caps are the backstop |
| Local state rollback (cache deleted) | Mitigated | Idempotency and window caps are on-chain |
| Malicious or stale RPC | Mitigated | Chain-id and code-hash checks; multi-RPC comparison flagged as future work |
| Software-key extraction | Mitigated | HSM/KMS/Secure Enclave/TPM preferred; software is explicit opt-in |
| Pause abuse via agent role | Mitigated | Agent role cannot pause |
| Fixed-window boundary burst | Mitigated | Documented cap-sizing rule; rolling window flagged as future |
| Replay of signed transaction across chains | Mitigated | Chain-id check in `rmpc`; EIP-155 signing |
| Replay of signed transaction within chain (nonce reuse) | Mitigated | Per-agent nonce file lock (`implementation-plan.md` §4.6) |
| Race between concurrent agent tasks | Mitigated | `ErrConcurrentInvocation` from nonce lock |
| Signer-backend MITM (TPM/HSM message tampering) | Inherited | Trust collapses to the signer device |

---

## 11. Off-chain — dapp / frontend / web2

| Attack | Status | Notes / evidence |
|---|---|---|
| Frontend JS injection (Bybit/Safe-class) — malicious bundle altering tx params | Unaddressed | No documented hosting model, SRI policy, or bundle-pinning. Triage: define hosting (IPFS-pinned, content-hash deploys, or strict CSP + SRI), and document signing-request display requirements |
| Build-pipeline compromise (poisoned npm/yarn install during deploy) | Unaddressed | No documented reproducible-build or signed-release policy for the dapp. Triage: pin lockfiles, sign release tags, consider provenance attestation |
| DNS hijack / phishing clone domain | Unaddressed | No published canonical domain list, no DNSSEC commitment, no ENS fallback. Triage: register and document official domain(s); commit to DNSSEC; publish ENS record |
| TLS/cert mis-issuance | Inherited | Standard CA trust; HSTS preload recommended |
| XSS in dapp | Unaddressed | No CSP policy documented. Out of MVP scope but should land before public dapp |
| CSRF on any backend signing endpoint | N/A | No backend signing endpoint — signing is client-side / agent-side only |
| WalletConnect-pairing abuse | Inherited | Standard wallet-connection risk; user-side |
| Clipboard-swap malware on user device | Inherited | User-side; documented in user education only |
| Permit / Permit2 phishing signature | Unaddressed | The vault accepts standard ERC-20 transfers; we do not require Permit. If the future dapp introduces Permit-based UX, this row needs re-triage |
| `eth_sign` / blind-signing UX | Mitigated by design | `rmpc` builds known calldata; the dapp must mirror this — call out in dapp spec when written |
| Transaction-front-running by RPC provider | Inherited | A privileged RPC could observe and reorder; same as the malicious-RPC row in §10 |

---

## 12. Off-chain — chain & infrastructure

| Attack | Status | Notes / evidence |
|---|---|---|
| Base sequencer censorship | Inherited | L2 risk; force-inclusion via L1 documented by Base, not by us |
| Base sequencer reorg | Inherited | Confirmation depth is the user/operator's call |
| L1 reorg affecting L2 finality | Inherited | Same |
| RPC provider outage | Mitigated by design | `architecture.md` flags multi-RPC comparison as future work |
| Mempool-leak exposing pending agent intents | Unaddressed | Public mempool exposes agent deposits before inclusion. Acceptable for MVP since deposits are irreversible by design and have no slippage; revisit when bucket-B/C legs ship |
| Time/clock skew on signer | Mitigated | Signing uses EVM block context, not wall time. `rmpc` uses local time only for log timestamps |

---

## 13. Operational — keys, secrets, deployment

| Attack | Status | Notes / evidence |
|---|---|---|
| Deploy-key compromise pushes a malicious contract | Unaddressed | No documented multi-party deploy-review or on-chain `CREATE2` salt-pinning. Triage: require deploy artifacts to match a tagged commit and a verified BaseScan entry within N minutes of deploy |
| Verified-source / deployed-bytecode mismatch | Mitigated | All four contracts verified; verification is the public attestation |
| Secret leak via repo (env files, JSON keystores) | Mitigated | Standard `.gitignore` patterns; recent gardening sweep removed deprecated TS CLI |
| CI runner compromise injecting deploy artifact | Unaddressed | No documented hardened-runner policy. Triage: pin runner versions, require human approval on deploy jobs |
| Backup loss / single-keeper-of-seed | Inherited | Multisig signers are individually responsible |
| Insider threat (rogue contributor) | Unaddressed | No documented two-reviewer rule on contracts repo or branch protection on contract paths. Triage: enforce CODEOWNERS for `contracts/**` |

---

## 14. Process — audit & institutional memory

| Attack class | Status | Notes / evidence |
|---|---|---|
| Selectively audited surface — new contract ships unaudited | Unaddressed | `efb2b90` adds an internal security review, but there is no published audit-scope ledger mapping contracts ↔ audit reports. Triage: maintain a `docs/audits.md` index |
| Economic vs. code-only audits (YieldBlox-class) | Unaddressed | No economic-model audit on bucket-B/C composition logic (still pre-MVP). Required before bucket-B/C ships |
| Bug-bounty exclusion of new high-risk contract | Unaddressed | No bug-bounty program documented. Triage: publish scope and exclusions explicitly when one launches |
| Pattern repetition — same vulnerability across deployments | Unaddressed | See dismissed-finding row in §9 |
| Near-miss dismissal | Unaddressed | Same — no register, no review cadence |
| Disclosure-handling failure | Unaddressed | No documented `SECURITY.md` / disclosure address. Triage: add `SECURITY.md` to repo root |

---

## 15. Out of scope — explicit non-goals

These are deliberately not addressed and will not be addressed under
the current product shape. Listing them here is itself the
mitigation: it prevents a future contributor from assuming we will
defend against them.

- Custodial key management for end users (`prd.md` §8).
- Hosted signing services (`prd.md` §8).
- Fiat on/off ramps (`prd.md` §8).
- Direct user calls into Compound/Aave (`prd.md` §8) — concentrating
  flows through the vault is itself part of the safety story.
- Defending against full multisig-quorum compromise (`architecture.md`
  §15) — at that point, the protocol has lost its trust anchor by
  definition.
- Solana-specific attack classes (durable-nonce abuse, etc.) — Robot
  Money is EVM-only.

---

## 16. Triage backlog

Every **Unaddressed** row above is a candidate triage item. The ones
worth landing first, ordered by blast radius:

1. ERC-4626 inflation / donation-to-reserves analysis (§3) — directly
   user-funds-relevant.
2. `SECURITY.md` and disclosure address (§14) — cheap, immediate.
3. Signer playbook for the multisig (§4) — operational, no code.
4. CODEOWNERS on `contracts/**` and deploy review policy (§13) —
   operational, no code.
5. Frontend hosting / SRI / canonical-domain commitment (§11) —
   blocks public dapp.
6. Dismissed-finding register (§9, §14) — process, prevents
   institutional-memory failures.
7. MEV-on-rebalance estimate (§7) — research task; may or may not
   need code.

---

## 17. Revision policy

Update this document when any of the following change:

- A new contract or adapter ships.
- A new chain or bridge is added.
- The dapp or any frontend hosting model changes.
- An audit completes (link the report from §14).
- A new attack class is published that is not yet listed here.
- A row's status changes (e.g., **Unaddressed** → **Mitigated**
  after a fix lands).

Pair-review changes to §15 (out-of-scope) — moving an item out of
scope is a meaningful product decision.
