<!--
  Canonical: docs/technical/security-model.md §9 / §14
  Feature work: issue #1010 (Security disclosure ledger phase)

  This is the institutional-memory artifact mandated by security-model.md:
    - §14 "Selectively audited surface"  -> Audit-scope ledger (below)
    - §14 "Pattern repetition across deployments" -> Finding register with a
      mandatory "Checked against" column
    - §9  "Dismissed audit finding later exploited (Venus-class)" /
      §14 "Near-miss dismissal" -> every finding logged with a disposition
      (fixed | accepted-with-rationale | dismissed-with-rationale) and, for
      dismissed/accepted findings, a Finding-disposition log entry.

  Structural enforcement: scripts/check-audit-ledger.sh asserts this file's
  sections, the finding-register columns, and that every register row carries a
  non-empty disposition from the allowed enum and a non-empty "Checked against"
  value. DO NOT rename a section heading or a register column header without
  updating that script in the same change. The "Remediated by (PR)" column is
  positioned AFTER "Checked against" so the script's column-position parse
  (disposition = field 5, checked-against = field 6) stays valid. The script
  also keys each review under docs/code-review/ dated 2026-10-12 or later
  (REVIEW_KEYS in the script; SR-1012 = 20261012-security-review.md) and
  requires one register row `<KEY>-N` per numbered finding heading `### N.` in
  that review, and no `<KEY>-N` row without its heading (issue #1792).

  Disposition discipline (per #1010): rows transcribe the *disposition already
  recorded in the cited snapshot* under docs/code-review/.
  No finding is re-audited or re-triaged here. Where a snapshot is a
  verification/grade rather than a remediation log, the mapping rule used is:
    REFUTED / "does not reproduce" / "miscalibrated, collapses" -> dismissed-with-rationale
    MITIGATED / "closed in code with pinning test" / "fix landed" -> fixed
    CONFIRMED-open with a remediation that LATER LANDED -> fixed + that PR
    CONFIRMED-open whose "fix specified" NEVER landed (verified absent at HEAD)
      -> accepted-with-rationale (open) — per the SR-0612-P1 landing-status rule
    CONFIRMED, accepted as documented/by-design/MVP risk -> accepted-with-rationale
  Each row's "Checked against" names the contract(s)/component(s) the snapshot
  verified the finding against (§14 cross-reference requirement).

  "Remediated by (PR)" names the merged PR that landed the fix, verified against
  the diff at HEAD on `dev`. It is "—" for accepted/dismissed findings (nothing
  to remediate). Several FS-0619 dispositions were corrected from the original
  ledger to match VERIFIED landing status: off-chain findings whose fix landed in
  the Off-chain scan-remediation phases (#1009/#1035) are now fixed + PR; contract
  findings whose "fix specified" never landed (RTR-1, VLT-10, VLT-19) are
  corrected to accepted-with-rationale (open). This applies the same landing-not-
  claimed discipline §SR-0612-P1 already records.
-->

# Robot Money — Audit Ledger

> Canonical requirements: `docs/technical/security-model.md` §9 (finding
> disposition) and §14 (audit-scope ledger, finding register, cross-reference).
> This document is the institutional-memory artifact those sections mandate.
>
> **Disposition enum (§9):** `fixed` · `accepted-with-rationale` ·
> `dismissed-with-rationale`. Every finding-register row carries exactly one.
>
> **Source snapshots** are the external review/audit/scan reports under
> `docs/code-review/`. This ledger transcribes the
> dispositions those snapshots record; it does not re-audit or re-triage.
>
> **Remediated by (PR)** points to the merged PR that landed the fix (verified
> against the diff at HEAD). `—` means the finding was accepted or dismissed and
> has no remediation. Every `fixed` row carries a PR. A fix that so far lives only
> on the `qa/test-merge-v1` branch names its QA plan v1 task and commit instead
> (`docs/development/qa-plan-v1.md`).
>
> **Source re-checks.** Where a later review showed a recorded disposition no
> longer matched source, the row was re-checked against source and says so with
> a date and a source line. The 2026-10-15 re-check (issue #1792, finding
> SR-1012-9) changed AZ-BSK-3, AZ-GW-3, AZ-GOV-1, HR-L-9 and HR-L-11, and added a
> source line to every row the 2026-10-12 review listed as unverified.
>
> **One row per finding heading.** `scripts/check-audit-ledger.sh` fails when a
> keyed review under `docs/code-review/` has a numbered finding heading
> (`### N. …`) with no `<KEY>-N` row here. A review dated 2026-10-12 or later
> must be keyed, so a new review cannot land without its rows.

## Audit-scope ledger

<!--
  §14 "Selectively audited surface": map every production contract to the audit
  report(s) that covered it. Production Solidity = contracts/*.sol +
  contracts/{adapters,gateway,vaults,lib}/*.sol, excluding contracts/test/,
  contracts/script/, contracts/interfaces/, and the generated contracts/doc/
  mirror. No contract may ship to production without a completed audit or an
  explicit documented exception approved by the team.

  Report keys used in the table:
    VA-0609 = docs/code-review/20260609-code-review-internal-claude.md
    HR-0618 = docs/code-review/20260618-code-review-internal-claude.md
    MC-0619 = docs/code-review/20260619-code-review-pekshield.md (multi-contract)
    FS-0619 = docs/code-review/20260619-code-review-internal-claude-scan-verification.md (full-stack scan)
    CD-0602 = docs/code-review/20260602-code-review-internal-claude.md
    DC-0606 = docs/code-review/20260606-code-review-internal-claude.md
    SR-0612 = docs/code-review/20260612-code-review-internal-claude.md
    AZ-0623 = docs/code-review/20260623-code-review-testmachine-azimuth.md
    SR-1012 = docs/code-review/20261012-security-review.md
-->

Every production contract under `contracts/` (excluding `contracts/test/`,
`contracts/script/`, `contracts/interfaces/`, and the generated
`contracts/doc/` mirror) is mapped. `scripts/check-audit-ledger.sh` fails when
a shipped `.sol` has no row here and when a row names a file that no longer
exists. Test-only contracts live under `contracts/test/` and are not shipped to the audit report(s) that covered it.

| Contract | Audit report(s) | Status | Exception (if any) |
|---|---|---|---|
| `RobotMoneyVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | — |
| `PortfolioRouter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, SR-0612, AZ-0623 | Audited | Post-audit change (issue 1746): zero-amount legs are skipped and the rounding remainder goes to the last non-zero-bps leg (`_executeLegs`, `_availabilityAndAmounts`, new `NoFundedLeg` error). This value-routing change is NOT covered by the reports above and is on the list for the external audit before the final deployment. The live Base 8453 router bytecode is unchanged. |
| `RouterGovernance.sol` | VA-0609, HR-0618, MC-0619, CD-0602, SR-0612, AZ-0623 | Audited | — |
| `VaultRegistry.sol` | VA-0609, HR-0618, MC-0619, CD-0602, SR-0612, AZ-0623 | Audited | — |
| `FeatureFlags.sol` | VA-0609 | Audited | Pre-mainnet re-audit pending under the bucket-B/C economic-audit gate (security-model.md §14) |
| `ExclusionLedger.sol` | none | Not separately audited | Written after SR-1012 (core 1820, QA plan v1 task D3, commit `83e1899a`). Each `RobotMoneyVault` deploys one in its constructor. It holds the USDC recovered from an excluded adapter and pays it pro rata to the holders at the moment of exclusion (finding SR-1012-1). The vault is its only writer; `claim` is permissionless and always pays the holder. Not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `ProposerFloorTimelock.sol` | none | Not separately audited | Written after SR-1012 (core 1645, QA plan v1 task B3, commit `92c8c84e`). Stock OpenZeppelin `TimelockController` plus a hand-kept `proposerCount`: revoking or renouncing the last `PROPOSER_ROLE` holder reverts `LastProposerFloor`. Not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `ExclusionLedgerFactory.sol` | none | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §9 item 3, QA plan v1 task P1). Stateless, admin-free factory deployed once per chain by CREATE2 in the libs stage. `create(asset)` deploys an `ExclusionLedger` bound to `msg.sender`, so a vault can only create its own ledger; the `RobotMoneyVault` initializer checks `VAULT() == address(this)`. It keeps the ledger's creation code out of the vault's runtime. Not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `gateway/RobotMoneyGateway.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | — |
| `gateway/AccessRoles.sol` | VA-0609, HR-0618, MC-0619, CD-0602 | Audited | — |
| `gateway/ConsensusRecommendationReceipt.sol` | none | Not separately audited | Investment-committee receipt contract; no snapshot in docs/code-review/ covers it. Launch exception B2 granted 2026-10-06 by the owner. Post-audit change (1620): inherits `AdminFloorAccessControl` and floors `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`; revoking or renouncing the last holder of either role reverts `LastAdminFloor`; a grant then renounce still hands the role over. The gateway binds this contract as an immutable, so a gateway redeploy needs a new copy of it |
| `gateway/InvestmentCommitteePolicy.sol` | none | Not separately audited | Investment-committee policy contract; no snapshot in docs/code-review/ covers it. Launch exception B2 granted 2026-10-06 by the owner. Post-audit change (1620): inherits `AdminFloorAccessControl` and floors `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`; revoking or renouncing the last holder of either role reverts `LastAdminFloor`; a grant then renounce still hands the role over. The gateway binds this contract as an immutable, so a gateway redeploy needs a new copy of it |
| `vaults/BasketVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | Bucket-B/C economic-model audit required before router-eligible production use (security-model.md §14; gap BASKET-001/ECONOMIC-AUDIT-001). Launch exception B2 granted 2026-10-06 by the owner: rmPROTO, rmAGENT and rmRWA may launch before the economic audit closes |
| `vaults/RwaBasketVault.sol` | none (thin subclass of `BasketVault`: name, symbol, asset cap) | Not separately audited | Same bucket-B/C economic-audit gate as BasketVault. Replaces the retired Chronicle-priced RWA vault (core 1492). Launch exception B2 granted 2026-10-06 by the owner: rmRWA may launch before its economic audit closes (plan decision 5) |
| `vaults/AgentTokenVault.sol` | VA-0609, HR-0618 | Audited | Same bucket-B/C economic-audit gate; launch exception B2 granted 2026-10-06 by the owner |
| `vaults/ProtocolAssetVault.sol` | VA-0609, HR-0618 | Audited | Same bucket-B/C economic-audit gate; launch exception B2 granted 2026-10-06 by the owner |
| `adapters/AaveV3Adapter.sol` | VA-0609, HR-0618, SR-0612 | Audited | — |
| `adapters/CompoundV3Adapter.sol` | VA-0609, HR-0618, FS-0619, SR-0612 | Audited | — |
| `adapters/MorphoAdapter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | — |
| `adapters/AerodromeSwapAdapter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | — |
| `adapters/UniswapV3SwapAdapter.sol` | none | Not separately audited | Used by rmRWA and any later basket asset that routes through a V3 adapter. rmAGENT no longer uses it for RM (owner decision 2026-10-08: RM trades on the Uniswap V4 pool through `UniswapV4SwapAdapter`). Launch exception B2 granted 2026-10-06 by the owner (plan decision 5) |
| `adapters/UniswapV4SwapAdapter.sol` | none | Not separately audited | Uniswap V4 venue executor for rmAGENT (RM on the V4 RM/USDC 2.91% pool), written against the real Base PoolManager (`unlock` callback, full PoolKey, hooks zero). Core 1676. Owner decision 2026-10-08: sufficient for the Base mainnet TEST, not the final deployment. Needs an external audit before the final deployment |
| `adapters/UniswapV4PriceRecorder.sol` | none | Not separately audited | Permissionless, admin-free tick recorder and V3-shaped `observe()` facade for the hookless V4 RM/USDC pool (a hookless V4 pool keeps no observations). Core 1676. Owner decision 2026-10-08: sufficient for the Base mainnet TEST, not the final deployment (a stronger source, such as a hooked oracle pool, is a later decision). The security bound is the pool depth: `perDepositCap` and `tvlCap` must stay below it. Needs an external audit before the final deployment |
| `lib/TickMath.sol` | HR-0618 | Audited | Externalized library (HR-0618 L3-D1); `pure` math, byte-identical, mis-link operational risk noted |
| `lib/TwapTickMath.sol` | HR-0618 (via BasketVault TWAP path) | Audited | TWAP helper exercised through BasketVault NAV review |
| `lib/AdminFloorAccessControl.sol` | MC-0619 (via F-06 admin-floor remediation) | Audited | Admin-floor mixin introduced by the F-06 remediation |
| `lib/AdminFloorAccessControlCounter.sol` | HR-0618 (L-10) | Audited | Counter variant of the admin-floor mixin used by `RobotMoneyVault` and `BasketVault`; introduced by the HR-0618 L-10 remediation |
| `lib/BasketAssetConfigGuard.sol` | HR-0618, MC-0619 (via BasketVault addAsset path) | Audited | Reviewed through BasketVault `addAsset` config-validation findings. Post-audit change (core 1500): `requirePoolUsable` rejects a token with no bytecode and accepts a 1-byte code only when it is the Coinbase B20 marker `0xef`. Not yet re-reviewed. |
| `lib/BasketViews.sol` | HR-0618 (via BasketVault NAV/preview path) | Audited | View helper exercised through BasketVault preview findings |
| `lib/BpsMath.sol` | VA-0609, HR-0618 (via exit-fee rounding findings) | Audited | Basis-point math exercised through exit-fee rounding findings |
| `lib/ForeignTokenQuarantine.sol` | HR-0618 (via reabsorb/quarantine path) | Audited | Quarantine/reabsorb path reviewed under MC-0619 F-17 / HR-0618 |
| `lib/GovernedUpgrade.sol` | none | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §3-§6, QA plan v1 task P1). The one upgrade base of the nine proxied contracts: OZ `UUPSUpgradeable` (`lib/openzeppelin-contracts-upgradeable` v5.0.2) with one fixed upgrade authority, the deployment's `ProposerFloorTimelock`, stored once with no setter, and a one-way `freezeUpgrades(impl, codehash)`. Only `_authorizeUpgrade`, `freezeUpgrades` and the `upgradesFrozen()` view read the frozen bit, so a freeze never touches withdrawals. Not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `lib/VaultAdapterOps.sol` | none (bodies moved out of `RobotMoneyVault`) | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §9 item 2, QA plan v1 task P1). CREATE2-linked library that runs as `RobotMoneyVault` through `DELEGATECALL`: the adapter registry and every loop over it that moves USDC (deposit routing, proportional pulls, registry writes, exclusion records, emergency drains, rebalance legs). The vault keeps every role check, `nonReentrant` guard and entry gas floor. The move is not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `lib/BasketSwapOps.sol` | none (bodies moved out of `BasketVault`) | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §9 item 2, QA plan v1 task P1). CREATE2-linked library that runs as the basket vault through `DELEGATECALL`: every basket swap (deposit buy legs, redeem sell legs, both emergency unwinds, removed-asset re-absorption) and the emergency-guard and TWAP-window writes. Each swap floor is priced through the vault's own `assetUsdcValue` / `assetTokenValue` views. The vault keeps every role check, `nonReentrant` guard, gas floor and the share accounting. Same bucket-B/C economic-audit gate as BasketVault. The move is not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `lib/GatewayAuth.sol` | none (bodies moved out of `RobotMoneyGateway`) | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §9 item 2, QA plan v1 task P1). CREATE2-linked library that runs as the gateway through `DELEGATECALL`: the commit/reveal check and the agent's EIP-712 consent check of `revealAuthorization` (core 1791). The gateway keeps the EIP-712 domain and its `implementationVersion()` (ADR-0014 §10, core 1810). The move is not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `lib/GatewayWindows.sol` | none (bodies moved out of `RobotMoneyGateway`) | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §9 item 2, QA plan v1 task P1). CREATE2-linked library that runs as the gateway through `DELEGATECALL`: the per-agent rolling-window ring buffer behind the deposit and withdraw window caps (NC-7 / GW-4). The move is not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |
| `lib/GatewayWithdrawOps.sol` | none (bodies moved out of `RobotMoneyGateway`) | Not separately audited | Written after SR-1012 (core 1808, ADR-0014 §9 item 2, QA plan v1 task P1). CREATE2-linked library that runs as the gateway through `DELEGATECALL`: the policy checks of `withdraw`, and the policy checks, intent hash and multi-leg execution of `withdrawFromRouter`. The gateway keeps the `AGENT_ROLE` gate, `nonReentrant`, the entry gas floor, the window accrual and the payment-id reservation. No pause applies to this path (core 1494). The move is not covered by any report above. QA plan v1 task S1 reviews it, and it needs an external audit before the final deployment |

> The Chronicle-priced RWA vault, its Chronicle adapter, the deSPXA position adapter and the
> original Uniswap V4 adapters are deleted (core 1492, plan decisions 8 and 9). Findings that named them stay
> in the register below as history. The Uniswap V4 swap adapter was rewritten and restored on 2026-10-08
> (core 1676) for rmAGENT; the V4 asset position adapter stays deleted (core 1677 defers it to the final deployment).
>
> The RM test token contract (formerly audited under VA-0609 and HR-0618) was retired on 2026-10-05
> and deleted under core 1489. RM is the live ROBOTMONEY token on Base
> (`0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3`), which this repo never deploys, so it has no row.
>
> No production contract ships without coverage above. The recorded exceptions
> (FeatureFlags pre-mainnet re-audit, the bucket-B/C basket-vault economic-audit
> gate, and the not-separately-audited gateway and swap-adapter rows) are
> the documented, team-approved carve-outs required by §14. The owner granted
> launch exception B2 on 2026-10-06: rmPROTO, rmAGENT and rmRWA, the IC policy,
> the consensus receipt, `UniswapV3SwapAdapter`, `UniswapV4SwapAdapter` and
> `UniswapV4PriceRecorder` may launch before their economic audit closes.
>
> **SR-1012 (2026-10-12) and the changes after it.** The 2026-10-12 security review
> (`docs/code-review/20261012-security-review.md`) read all 28 production contracts at
> baseline `2c81c742`. It reports findings and limits. It certifies nothing, so it changes
> no Status above. Its nine findings are rows SR-1012-1 to SR-1012-9 in the register below.
> These contracts changed after that baseline. No report above covers the change, and QA
> plan v1 task S1 reviews each one again:
>
> | Contract | Change after SR-1012 | Where it landed |
> |---|---|---|
> | `RobotMoneyVault.sol` | Deposits close while an active adapter is ineligible, and keeper `rebalance` skips it (core 1788). `addAdapter` refuses an active duplicate (core 1789). Exclusion recovery goes to `ExclusionLedger` (core 1820). A new ADMIN lever, `setAdapterMaxExposure`, caps one adapter's exposure | PR 1814 `d5c6a2e1`; QA D1, D3, D8 in `83e1899a` |
> | `PortfolioRouter.sol` | `setWeights` and `setDefaultWeights` refuse a duplicate vault (`DuplicateVault`). The deposit split skips a leg whose own `maxDeposit` is 0 | QA C1a `92c8c84e`; QA D4 `83e1899a` |
> | `RouterGovernance.sol` | The propose, vote and execute path is deleted. The contract keeps `applyReceipt`, `setDefaultWeights` and `clearVotedWeights` (core 1698) | QA C1a `92c8c84e` |
> | `gateway/RobotMoneyGateway.sol` | `committeeVoteSubmit` refuses `p.agent != msg.sender` (core 1790). A non-admin reveal for another agent needs that agent's EIP-712 consent, and `releaseAgent` frees an address bound without consent (core 1791) | PR 1818 `897f5b10`; QA D2 `83e1899a` |
> | `gateway/ConsensusRecommendationReceipt.sol`, `gateway/InvestmentCommitteePolicy.sol`, `FeatureFlags.sol` | Comments only: they name the one-call `applyReceipt`, which releases a receipt through the weight setter (core 1698) | QA C1a `92c8c84e` |
> | `VaultRegistry.sol` | The unused `IExactnessVault.allExact()` read is deleted | `83e1899a` |
> | `vaults/BasketVault.sol`, `lib/BasketViews.sol`, `lib/BasketAssetConfigGuard.sol` | Sell anchor on V4 legs (core 1793). One dust rule on every sell path. Emergency-unwind guard setter | QA D5, D6, D7 in `83e1899a` and `2b5d9c4a` |
> | The nine proxied contracts (`RobotMoneyVault.sol`, the three basket kinds through `vaults/BasketVault.sol`, `PortfolioRouter.sol`, `VaultRegistry.sol`, `gateway/RobotMoneyGateway.sol`, `gateway/InvestmentCommitteePolicy.sol`, `gateway/ConsensusRecommendationReceipt.sol`), `gateway/AccessRoles.sol`, `lib/AdminFloorAccessControl.sol`, `lib/AdminFloorAccessControlCounter.sol`, `lib/BasketAssetConfigGuard.sol`, `lib/BasketViews.sol`, `ExclusionLedger.sol` | Each proxied contract is a UUPS implementation behind its own ERC-1967 proxy (ADR-0014, core 1808): constructors became initializers, constructor immutables became write-once storage, and `GovernedUpgrade` adds the timelock-only upgrade and the one-way freeze. The access-control bases extend the OZ upgradeable parents. Code moved into the new linked libraries above to keep 1,024 B of EIP-170 margin. `ExclusionLedger` takes its vault as a constructor argument and is created by `ExclusionLedgerFactory`. The gateway's EIP-712 domain version reads `implementationVersion()` (core 1810) | QA P1 and P3 (ADR-0014 implementation records) |

## Finding register

<!--
  §14 "Pattern repetition across deployments": one row per finding, each with a
  "Checked against" field naming the contract(s)/component(s) the finding was
  verified against (cross-referenced, not only the originally-audited contract).
  Disposition is one of the §9 enum values; "Remediated by (PR)" cites the merged
  PR that landed the fix. Severity is the snapshot's (re-graded where the
  verification adjusted it: "orig->regrade").

  Coverage note: the large open-finding inventories in SR-0612 (49 findings,
  most "open on dev") and DC-0606 (74 claimed-fixed, 8 contradicted by SR-0612)
  and the gap-analysis backlog (50 tracked-as-future-work items, #643-#692) are
  summarized as grouped rows here with their snapshot as the authoritative
  source; the per-ID detail lives in those snapshots. The 2026-06-19 full-stack
  scan (FS-0619) and multi-contract audit (MC-0619) findings are transcribed
  per-ID below with their remediating PR (verified at HEAD).
-->

Disposition is one of `fixed` / `accepted-with-rationale` /
`dismissed-with-rationale` (§9). "Checked against" names the
contract(s)/component(s) the cited snapshot verified the finding against (§14).
"Remediated by (PR)" cites the merged PR that landed the fix (`—` = nothing to
remediate).

### FS-0619 — Full-stack automated scan verification (2026-06-19, 95 findings)

The external scan reported 95 findings (6 High, 61 Medium, 28 Low, 0 Critical);
the verification (`docs/code-review/20260619-code-review-internal-claude-scan-verification.md`)
collapses 3 duplicate listings into 92 distinct IDs and re-grades severities in
both directions. The four "High access-control" contract findings collapse
(consent is structural — share movement needs the victim's own gateway
allowance). The off-chain remediation landed in two phases — **#1009**
(Off-chain scan remediation) and **#1035** (residual) — so every CONFIRMED
indexer/watchdog/rmpc/harness/dapp finding now carries its landed PR. CONTRACT
findings whose "fix specified" never landed (FS-VLT-10) are corrected to
`accepted-with-rationale` (open); FS-VLT-19 is now `fixed` — #1092 gives
`BasketVault` matching-selector `retire()`/`unretire()` implementations, so
`vaults/` subclasses no longer revert on `IRetirableVault(vault).retire()`;
FS-VLT-25 does not reproduce.
The 2026-07-28 reconciliation found that seven AZ-0623 fixes and the FS-RTR-1
fix had merged after this ledger was last updated; those rows now record their
merged remediation PRs rather than the stale accepted dispositions.

| Finding ID | Source | Severity (orig→regrade) | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| FS-IDX-1 | FS-0619 | High→Critical | fixed | explorer-indexer, watchdog | #998 | Duplicate Withdraw handler left burn rows unwritten; merged dead branch so withdrawal rows persist + restored burn alarm |
| FS-IDX-2 | FS-0619 | High | fixed | explorer-indexer | #1029 | Failed run after reorg advanced cursor past deleted blocks; `delete_above_block` caps cursor to root for reorg-safe resume |
| FS-IDX-3 | FS-0619 | Medium | fixed | explorer-api, explorer-indexer | #1034 | Account-positions endpoint never populated; `insert_wallet_position` wired into deposit/withdraw branches |
| FS-IDX-4 | FS-0619 | Medium | fixed | explorer-indexer, watchdog | #1001 | Direct ERC-4626 deposits excluded from mint-volume; now included, deduped by tx_hash |
| FS-IDX-5 | FS-0619 | Medium | fixed | explorer-indexer | #1034 | Vote tally counted voters not power; now sums vote weight (NUMERIC widening, migration 0013) |
| FS-IDX-6 | FS-0619 | Medium | fixed | explorer-indexer, watchdog | #1001 | Registry-discovered vaults missing from burn watch set; unioned into watched-address set |
| FS-IDX-7 | FS-0619 | Medium | fixed | explorer-indexer, watchdog | #1001 | Routed deposits double-counted in mint-volume; parent excluded from leg accounting |
| FS-IDX-8 | FS-0619 | Medium | fixed | explorer-indexer | #1029 | Reorg rollback didn't revert in-place status updates; append-only status events (migration 0012) + re-derive on reorg |
| FS-IDX-9 | FS-0619 | Medium→down | dismissed-with-rationale | explorer-indexer | — | Legacy agent lookup owner-scope claim refuted as a vulnerability |
| FS-IDX-10 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | — | Direct ERC-4626 deposits omitted from per-account history; display gap, not remediated |
| FS-IDX-11 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | — | Proposal status never advanced to passed/expired; display gap |
| FS-IDX-12 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | — | Legacy agent status marks expired policies authorized; display gap |
| FS-IDX-13 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | — | Policy-change history attributed to agent not owner; display attribution |
| FS-IDX-14 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | — | Routed deposits show share receiver as vault in stats feed; display |
| FS-IDX-15 | FS-0619 | Low | accepted-with-rationale | explorer-api | — | Chain-scoping bypass on several reads; partial, read-only, not remediated |
| FS-IDX-16 | FS-0619 | Low | accepted-with-rationale | explorer-api | — | Vault-detail history stale after 500-snapshot cap; display |
| FS-WD-1 | FS-0619 | Medium→High | fixed | watchdog | #1001 | Pause awaited before alert, no RPC timeout, SLA unenforced; alert-first + per-call timeouts bounded by SLA |
| FS-WD-2 | FS-0619 | Medium | fixed | watchdog | #1001 | Hourly window used wall-clock not chain time; now anchored to evaluated block's on-chain timestamp |
| FS-WD-3 | FS-0619 | Medium→Low | dismissed-with-rationale | watchdog | — | RLP r/s non-minimal encoding; ≈1/256 per scalar, most clients accept |
| FS-WD-4 | FS-0619 | Medium | fixed | watchdog | #1030 | Per-vault thresholds parsed but never enforced; per-vault burn/mint aggregations now enforced (collapsed dup) |
| FS-WD-5 | FS-0619 | Medium | fixed | watchdog | #1001 | Pause retries used pending nonce; now confirmed nonce + fee-bump so retry replaces stuck tx |
| FS-WD-6 | FS-0619 | Medium→High | fixed | watchdog | #1001 | Per-block thresholds only inspected latest indexed block; durable cursor iterates every new block (collapsed dup) |
| FS-RTR-1 | FS-0619 | High→Medium | fixed | PortfolioRouter | #1093 | Pre-existing USDC dust could brick router deposits; the balance-delta custody invariant excludes pre-existing donations and preserves all-or-revert behavior for blacklist failures. |
| FS-RTR-2 | FS-0619 | High→Low | fixed | RobotMoneyGateway, PortfolioRouter | #836 | Redeemer allowance-guard not consumed; `UnauthorizedRedeemer` guard mitigates (gateway self-custodies), confused-deputy theoretical |
| FS-RTR-3 | FS-0619 | High→Low/Info | dismissed-with-rationale | PortfolioRouter, RobotMoneyGateway | — | "Arbitrary shareReceiver pull" refuted: plain transferFrom needs victim's own allowance; one of 4 collapsing High findings (listed twice) |
| FS-RTR-4 | FS-0619 | Medium→Low | dismissed-with-rationale | PortfolioRouter | — | Agent authorization needs no agent consent; `_assertRoleSeparation` blocks the AGENT_ROLE escalation. Superseded 2026-10-15: SR-1012-7 showed the missing consent lets a caller squat another agent's policy ownership, and core 1791 (QA D2 `83e1899a`) now requires the agent's EIP-712 consent |
| FS-RTR-5 | FS-0619 | Medium | accepted-with-rationale | PortfolioRouter | — | Commit/reveal front-run squatter DoS; nuisance, confirmed |
| FS-RTR-6 | FS-0619 | Medium→Low | accepted-with-rationale | RobotMoneyGateway | — | `depositTo` paymentId omits destination + minSharesPerLeg; benign, self-affecting |
| FS-RTR-7 | FS-0619 | Medium | accepted-with-rationale | PortfolioRouter | — | Empty `allowedSourceVaults` not enforced on router withdrawals; hardening |
| FS-RTR-8 | FS-0619 | Medium→Low | accepted-with-rationale | RobotMoneyGateway | — | Router withdrawals can't enforce per-leg min assets; by design (L-8) |
| FS-RTR-9 | FS-0619 | Medium→Low | accepted-with-rationale | PortfolioRouter | — | Router-withdrawal paymentId binds only totalShares; benign |
| FS-RTR-10 | FS-0619 | Medium→Low | accepted-with-rationale | PortfolioRouter | — | Rounding remainder lets tiny split deposits bypass weights; cosmetic |
| FS-VLT-1 | FS-0619 | Medium→Info | accepted-with-rationale | RobotMoneyVault | — | `IUpstreamMonitor` health gate not enforced; by-design stub |
| FS-VLT-2 | FS-0619 | Medium→Info | dismissed-with-rationale | AerodromeSwapAdapter | — | Slipstream slot0 ABI "mismatch" refuted; targets repo's own internally-consistent shim |
| FS-VLT-3 | FS-0619 | Medium | accepted-with-rationale | retired RWA vault, retired Chronicle adapter | — | Chronicle RWA route vs V3-style addAsset checks; latent integration |
| FS-VLT-4 | FS-0619 | Medium→Info | dismissed-with-rationale | CompoundV3Adapter | — | Rewards "not harvested" refuted; they accrue in share price |
| FS-VLT-5 | FS-0619 | Medium | accepted-with-rationale | RobotMoneyVault | — | Deposits mint on max-slippage haircut; by design (H-1) |
| FS-VLT-6 | FS-0619 | Medium→down | dismissed-with-rationale | BasketVault | — | "Greedy deposit reverts" refuted for HEAD (skips + idles); claim on stale `src/` |
| FS-VLT-7 | FS-0619 | Medium | dismissed-with-rationale | RobotMoneyVault | — | "Idle assets excluded from totalAssets" refuted; HEAD includes idle |
| FS-VLT-8 | FS-0619 | Medium→down | accepted-with-rationale | RobotMoneyVault | — | Idle-first withdrawals; matches HEAD, benign |
| FS-VLT-9 | FS-0619 | Medium | accepted-with-rationale | BasketVault | — | Inactive asset entries consume basket capacity; low impact |
| FS-VLT-10 | FS-0619 | Medium | accepted-with-rationale | MorphoAdapter | — | Morpho reports illiquid shares as withdrawable; CONFIRMED at HEAD — `totalAssets()` still `convertToAssets(shares)` with no maxWithdraw cap, no fix landed. Re-checked 2026-10-15 (SR-1012-9): unchanged at `MorphoAdapter.sol:171-174`; still open, close before mainnet |
| FS-VLT-11 | FS-0619 | Medium | dismissed-with-rationale | BasketVault, MorphoAdapter | — | Stale duplicate of FS-VLT-10 |
| FS-VLT-12 | FS-0619 | Medium→down | accepted-with-rationale | VaultRegistry, vault | — | Registry Paused doesn't halt direct deposits; router gates by design |
| FS-VLT-13 | FS-0619 | Medium | accepted-with-rationale | retired RWA vault | — | RWA redemption blocked by price deviation from NAV; by design (ADR-0006) |
| FS-VLT-14 | FS-0619 | Medium→Info | dismissed-with-rationale | retired RWA vault, retired Chronicle adapter | — | RWA freshness `latestTimestamp()` "noncanonical" refuted; own the retired Chronicle interface |
| FS-VLT-15 | FS-0619 | Medium→down | fixed | RobotMoneyVault | #200 | Receipt-token donation inflation mitigated by 1e18 `_decimalsOffset` (mitigation pre-dates the scan) |
| FS-VLT-16 | FS-0619 | Medium→Info | dismissed-with-rationale | retired V4 adapter | — | "Noncanonical router ABI" refuted; own shim |
| FS-VLT-17 | FS-0619 | Medium→down | accepted-with-rationale | retired V4 adapter | #1186 | Router-eligibility now proven end-to-end (`the retired V4 router integration test`: real Vault + VaultRegistry + PortfolioRouter, deposit drives adapter.deploy()); V4 pricing still assumes a V3-shaped observe() pool rather than real v4-core's PoolManager singleton — that half remains accepted-with-rationale, unchanged. Update 2026-10-08 (core 1676): the retired adapter is gone. The restored `UniswapV4SwapAdapter` swaps through the real PoolManager (unlock callback, full PoolKey), and prices through the V3-shaped `UniswapV4PriceRecorder` facade, which reads the pool tick through the PoolManager `extsload` and records it itself, so no pricing path assumes a V4 pool address with `observe()`. Accepted-with-rationale for the mainnet TEST only: the recorder's security bound is the pool depth, and a stronger source is a later decision |
| FS-VLT-18 | FS-0619 | Medium | fixed | VaultRegistry, RobotMoneyVault | #959 | Retire left router-eligibility state stale; unified registry-driven `retire()`/`unretire()` on the base vault |
| FS-VLT-19 | FS-0619 | Medium | fixed | VaultRegistry, BasketVault | #1092 | Registry retire() reverted on basket subclasses; `BasketVault` now implements matching-selector `retire()`/`unretire()` so `vaults/` subclasses dispatch correctly, registry-side calls no longer try/catch the hook |
| FS-VLT-20 | FS-0619 | Medium→down | accepted-with-rationale | BasketVault | — | Withdrawals/rebalance push adapters above caps; by design, re-converges |
| FS-VLT-21 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | `redeem()` return diverges from USDC transferred; confirmed, minor. Re-checked 2026-10-15 (SR-1012-9): `_withdraw` pays the receiver exactly the returned `assets` and sends the exit fee separately (`RobotMoneyVault._withdraw`, `RobotMoneyVault.sol:808,811`), so the vault's USDC outflow is `assets + fee` while `redeem` returns `assets` (ERC-4626 net semantics) |
| FS-VLT-22 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | Exact-asset withdraw overcharges fee (ceil gross-up); ±1 unit dust. Re-checked 2026-10-15 (SR-1012-9): unchanged, `_netToGross` rounds up (`RobotMoneyVault.sol:731-734`) |
| FS-VLT-23 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | Exit fee rounds to zero on dust chunks; ±1 unit dust. Re-checked 2026-10-15 (SR-1012-9): unchanged, `_grossToNet` floors the fee (`RobotMoneyVault.sol:727-729`) |
| FS-VLT-24 | FS-0619 | Medium→down | dismissed-with-rationale | RobotMoneyVault | — | "maxWithdraw unwithdrawable" refuted; L-1 floor fix is a counter-example |
| FS-VLT-25 | FS-0619 | Low→Medium | dismissed-with-rationale | RobotMoneyVault | — | "Emergency-unwind deposit-pause uncleanable" refuted; `emergencyUnwind` sets only `depositsPaused`, already cleared by Pausable-independent `_setDepositsPaused(false)` |
| FS-VLT-26 | FS-0619 | Low | accepted-with-rationale | BasketVault | — | Dust donations block asset removal; confirmed, minor |
| FS-VLT-27 | FS-0619 | Low→Info | accepted-with-rationale | RobotMoneyVault | — | `decimals()=6` vs `_decimalsOffset()=18`; documented. Re-checked 2026-10-15 (SR-1012-9): unchanged and documented in the NatSpec of `decimals` and `_decimalsOffset` (`RobotMoneyVault.sol:487-529`) |
| FS-RPC-1 | FS-0619 | Medium | fixed | rmpc | #1031 | `get-agent` used deprecated calendar-window gross; now reads rolling-window gross |
| FS-RPC-2 | FS-0619 | Medium→High(local) | fixed | rmpc | #999 | Replay cache written before receipt success; `ReplayCache::remove` on revert/timeout |
| FS-RPC-3 | FS-0619 | Medium | fixed | rmpc | #999 | Failover stopped on transient indexing error; transient RPC now retryable past `Ok(None)` |
| FS-RPC-4 | FS-0619 | Medium | fixed | rmpc | #999 | Missing `result` accepted as null receipt; malformed receipt no longer terminal (paired with FS-RPC-3) |
| FS-RPC-5 | FS-0619 | Medium→High | fixed | rmpc | #999 | Vote proposal-id parsed hex-before-decimal; now decimal-first, hex only with `0x` prefix |
| FS-RPC-6 | FS-0619 | Medium→Low | dismissed-with-rationale | rmpc | — | Keystore files not 0600; downgraded — contents are an encrypted blob |
| FS-RPC-7 | FS-0619 | Medium→High(router) | fixed | rmpc | #999 | Withdraw preflight omitted share allowance/balance; now runs real per-leg checks |
| FS-RPC-8 | FS-0619 | Low | accepted-with-rationale | rmpc | — | Agent-expiry preflight uses wall-clock; confirmed, minor |
| FS-RPC-9 | FS-0619 | Low | fixed | rmpc | #1002 | Deposit/status logs unbounded by envelope block; reads pinned to sampled block |
| FS-RPC-10 | FS-0619 | Low | accepted-with-rationale | rmpc | — | Keystore import leaves key in non-zeroized buffers; confirmed, minor |
| FS-RPC-11 | FS-0619 | Low | accepted-with-rationale | rmpc | — | Pending timelock ops dropped on getTimestamp failure; CONFIRMED — #1002 surfaced FS-RPC-13 only, this path not remediated |
| FS-RPC-12 | FS-0619 | Low | accepted-with-rationale | rmpc | — | Router deposits share vault-deposit replay namespace; confirmed, minor |
| FS-RPC-13 | FS-0619 | Low | fixed | rmpc | #1002 | Self-check reported zero allowance on read failure; now surfaces partial/`share_allowance_read_ok=false` |
| FS-RPC-14 | FS-0619 | Low | fixed | rmpc, dapp | #1002 | Role membership ignored grant/revoke chronology; `get_timelock` replays events in (block, log_index) order |
| FS-RPC-15 | FS-0619 | Low | fixed | rmpc | #1002 | `get-tx`/`get-balance` receipt postdated envelope block; pinned to sampled block (FS-RPC-9 class) |
| FS-RPC-16 | FS-0619 | Low | fixed | rmpc | #1002 | Unpinned balance/allowance reads; pinned to sampled block (FS-RPC-9 class) |
| FS-RPC-17 | FS-0619 | Low→Info | dismissed-with-rationale | rmpc | — | Vault share-price overflow saturates; overflow needs absurd decimals/supply, unreachable |
| FS-RPC-18 | FS-0619 | Low | accepted-with-rationale | rmpc | — | Withdraw flows omit local replay-cache checks; confirmed, minor |
| FS-HARN-1 | FS-0619 | Medium→Info/Low | dismissed-with-rationale | smoke-test/fork-e2e harness | — | Checked-in devnet faucet key; by-design throwaway genesis key, controls nothing of value |
| FS-HARN-2 | FS-0619 | Medium | fixed | harness, dapp build | #1026 | Faucet key in public bundle + tunnel + printed; guard test fails-closed for public/prod Vite build-arg classes |
| FS-HARN-3 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | — | Holder allowances/blacklist not scrubbed; requires control of committed fixtures |
| FS-HARN-4 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | — | Ingested impl account bypasses seed bytecode; requires control of committed fixtures |
| FS-HARN-5 | FS-0619 | Medium | fixed | harness | #1026 | Pinned manifest didn't authenticate snapshot bytes; `snapshot_sha256` digest added + verified before alloc (`--require-pinned`) |
| FS-HARN-6 | FS-0619 | Medium | fixed | harness | #1026 | USDC grant ignored packed blacklist bit (V2_1/V2_2); now masks/repacks slot-9 + saturates balance |
| FS-HARN-7 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | — | Seed can preserve minter authority; requires control of committed fixtures |
| FS-HARN-8 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | — | Seed not tied to pinned manifest; requires control of committed fixtures |
| FS-HARN-9 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | — | New run force-removes other runs' containers; local concurrent-run DoS only |
| FS-DAPP-1 | FS-0619 | Medium | fixed | dapp | #1032 | Governance UI gated on current power not snapshot; now gates on `getPastVotes` snapshot power |
| FS-DAPP-2 | FS-0619 | Medium | fixed | dapp | #1032 | Router deposit UI submitted zero per-leg share floors; now derives non-zero `minSharesPerLeg` (0.50% tol) |
| FS-DAPP-3 | FS-0619 | Medium→Low | dismissed-with-rationale | dapp | — | Stale-allowance UI checks agent not shareReceiver allowance; unwired dead code |
| FS-DAPP-4 | FS-0619 | Medium→High | fixed | dapp | #1000 | Destination selector didn't control direct-deposit target; selected vault threaded into single-vault path |
| FS-DAPP-5 | FS-0619 | Low→Medium | fixed | dapp | #1000 | `VaultDetail` decoded shortlist as structs not parallel arrays; ABI corrected to parallel-arrays |
| FS-DAPP-6 | FS-0619 | Low | fixed | dapp, rmpc | #1002 | Timelock panel ignored grant/revoke chronology; chronology-aware replay (mirrors FS-RPC-14) |

### MC-0619 — Multi-contract lifecycle audit verification (2026-06-19, F-01…F-19)

External multi-contract audit (1 High, 9 Medium, 5 Low, 4 Info). 17 of 18
substantive findings reproduce against HEAD; F-04 rests on a stale premise.
No unauthenticated EOA fund-drain; the real surface is lifecycle state composed
across contracts and where privileged roles land after deploy. The remediation
landed under phase **#987** (contract-security-remediation-2), via the per-finding
sub-PRs cited below.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| MC-F-01 | MC-0619 | High | fixed | RobotMoneyGateway, AccessRoles, DeployTimelock/Deploy scripts | #974 | Timelock handover incomplete (deployer EOA stayed root + held vault EMERGENCY_ROLE); grants admin/emergency to timelock + revokes from deployer (ACL-1) |
| MC-F-02 | MC-0619 | Medium | fixed | PortfolioRouter | #977 | Redeem leg required Active, conflicted with Retired withdraw-only; `_redeemLeg` now allows Active or Retired |
| MC-F-03 | MC-0619 | Medium | fixed | PortfolioRouter | #977 | Redeem iterated live weights not balances; now driven by explicit caller `vaults[]` (identity-bound) |
| MC-F-04 | MC-0619 | Medium | fixed | RobotMoneyVault, VaultRegistry | #976 | Registry/vault flag drift; atomic retire shipped earlier (#933/#958), #976 closes the residual `setVaultStatus` back-door (LIFE-1) |
| MC-F-05 | MC-0619 | Medium | fixed | PortfolioRouter | #976 | `setWeights` could write a non-depositable weight vector; now requires `VaultStatus == Active` per weighted vault |
| MC-F-06 | MC-0619 | Medium | fixed | RobotMoneyVault, BasketVault, AccessRoles | #975 | Admin-floor inconsistent; last-admin floor via `_revokeRole` on vaults + gateway (#974) (ACL-3) |
| MC-F-07 | MC-0619 | Medium | fixed | BasketVault, retired RWA vault | #980 | `shutdownVault` irreversible; ADMIN-gated `restoreVault(newTvlCap)` inverts it (LIFE-4) |
| MC-F-08 | MC-0619 | Medium | fixed | retired RWA vault | #975 | Stale-override + unwind under one EMERGENCY key; `setEmergencyUnwindStaleOverride` moved to ADMIN_ROLE (ACL-5) |
| MC-F-09 | MC-0619 | Medium | fixed | retired V4 adapter, AerodromeSwapAdapter, BasketVault | #975 | TWAP quote pool could mismatch execution pool; `BasketAssetConfigGuard` asserts execution-pool == TWAP-pool in `addAsset` (ORA-3) |
| MC-F-10 | MC-0619 | Medium | fixed | retired RWA vault, retired Chronicle adapter | #978 | No NAV-vs-market deviation guard; timelock-configured deviation threshold reverts over-threshold deposits (ORA-4) |
| MC-F-11 | MC-0619 | Low | fixed | RobotMoneyGateway | #978 | Gateway zeroed router per-leg floor + disabled deadline; `withdrawFromRouter` forwards `minAssetsPerLeg[]` into intent hash (GW-5) |
| MC-F-12 | MC-0619 | Low | accepted-with-rationale | PortfolioRouter | — | Router cap per-tx only, splittable; documented as per-tx sanity bound (fix-or-document accepted, #980 recorded the decision) |
| MC-F-13 | MC-0619 | Low | fixed | PortfolioRouter | #976 | Deposit all-or-revert diverged from preview; `_executeLegs` now skip-and-renormalise (RTR-5) |
| MC-F-14 | MC-0619 | Low | fixed | RobotMoneyVault | #980 | Revoked-but-active adapter still trusted for NAV; `totalAssets`/`_pullProportional` exclude ineligible adapters (ADP-2) |
| MC-F-15 | MC-0619 | Low | fixed | RobotMoneyGateway | #979 | Idempotency hash omitted destination + per-leg shares; `depositTo` paymentId folds them in (GW-2); withdraw side already bound (#980) |
| MC-F-16 | MC-0619 | Info | fixed | RobotMoneyVault, MorphoAdapter, BasketVault | #978 | NAV trusted subcomponent prices/TWAP marks; `_deposit` mints on realized swap proceeds + round-trip pinned (SUP-3/NC-6) |
| MC-F-17 | MC-0619 | Info | fixed | retired Chronicle adapter, BasketVault | #979 | Reabsorb reused stale pool; `reabsorbRemovedAsset` wraps TWAP read in quarantine fallback (LIFE-6). Hardcoded-18-dec half accepted as latent (safe while deSPXA=18) |
| MC-F-18 | MC-0619 | Info | accepted-with-rationale | IUpstreamMonitor | — | Upstream health monitor interface-only stub (#702); deferred by design |
| MC-F-19 | MC-0619 | Info | dismissed-with-rationale | Slither output | — | Meta-comment; mostly known/low-risk patterns, no new action |

### VA-0609 / HR-0618 — Vulnerability audit + holistic remediation verification

The 2026-06-09 vulnerability audit (H-1, M-1…M-10, L-1…L-17, I-1…I-10) verified
against HEAD by the 2026-06-18 holistic review, which is the authoritative
disposition source. Every High/Medium closed in code with a pinning regression
test in PR **#836** (the atomic VA-0609 remediation), except M-10 (split:
vote-snapshot half fixed, `setWeights`-bypass half accepted as the documented
multisig+timelock MVP property). The in-trust-model lows the HR-0618 snapshot
left open (L-3, L-8, L-10, L3-D1) were subsequently remediated by **#920**, and
the Passthrough natspec drift (L3-D2) by **#922**.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| HR-H-1 | VA-0609/HR-0618 | High | fixed | BasketVault | #836 | `mint()` slippage-haircut bypass; symmetric `previewMint` gross-up, pinned |
| HR-M-1 | VA-0609/HR-0618 | Medium | fixed | retired Chronicle adapter | #836 | Rejects zero/degenerate oracle price; bounds pinned |
| HR-M-2 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyVault | #836 | `withdraw(maxWithdraw)` 4626 violation; fee-enabled conformance suite |
| HR-M-3 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyVault | #836 | `forceRemoveAdapter` now pauses deposits; pinned |
| HR-M-4 | VA-0609/HR-0618 | Medium | fixed | retired RWA vault, BasketVault | #836 | RWA emergency unwind staleness gate on both paths; pinned |
| HR-M-5 | VA-0609/HR-0618 | Medium | fixed | PortfolioRouter | #836 | `redeemFor` caller authorization enforced; pinned |
| HR-M-6 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyGateway | #836 | Per-window cap true sliding window; pinned + fuzz |
| HR-M-7 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyGateway | #836 | Caller-bound commit/reveal; pinned |
| HR-M-8 | VA-0609/HR-0618 | Medium | fixed | BasketVault | #836 | Redeem-only enforcement for 4626 exactness; pinned |
| HR-M-9 | VA-0609/HR-0618 | Medium | fixed | RouterGovernance | #836 | `MIN_EXECUTION_DELAY` in setter + constructor; pinned (deploy default raised 0→3600 by #867) |
| HR-M-10 | VA-0609/HR-0618 | Medium | accepted-with-rationale / dismissed-with-rationale | RouterGovernance, PortfolioRouter | #836 | Vote-snapshot half fixed (pinned, #836); `setWeights`-bypass half accepted as documented multisig+timelock MVP property (overall: partial) |
| HR-L-1 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | #836 | max-* views zeroed while withdrawals paused; pinned |
| HR-L-2 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | #836 | `_pullProportional` last-adapter sweep/clamp DoS; pinned |
| HR-L-3 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | #920 | Irreversible `shutdownVault` under EMERGENCY_ROLE; ADMIN-gated `restoreVault` makes it recoverable (open at HR-0618 HEAD, fixed by #920) |
| HR-L-4 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | #836 | Allowlist revocation no longer bricks deposits (skips ineligible adapter); pinned |
| HR-L-5 | VA-0609/HR-0618 | Low | fixed | AerodromeSwapAdapter, retired Chronicle adapter, retired V4 adapter | #836 | Caller deadline forwarded; pinned |
| HR-L-6 | VA-0609/HR-0618 | Low | fixed | retired V4 adapter | #836 | SafeCast on uint128 truncation; pinned |
| HR-L-7 | VA-0609/HR-0618 | Low | fixed | AerodromeSwapAdapter, retired Chronicle adapter | #836 | Unchecked router return-array indexing; structural rewrite (Chronicle secondary site lacks dedicated test) |
| HR-L-8 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter | #920 | `redeemFor` no slippage/deadline; `minAssetsPerLeg` + deadline added (open at HR-0618 HEAD, fixed by #920) |
| HR-L-9 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter, RouterGovernance | QA C1a `92c8c84e` (core 1698) | `setWeights` accepted duplicate vault entries; admin-gated, accepted until SR-1012-8 raised it again. Re-dispositioned 2026-10-15: `setWeights` and `_setDefaultWeights` call `_requireNoDuplicateBefore` and revert `DuplicateVault` (`PortfolioRouter.sol:508,595`, helper `_requireNoDuplicateBefore` at `:1388-1392`), so `applyReceipt` cannot write a duplicate either. Pinned by `PortfolioRouter.t.sol::test_setWeights_rejectsDuplicateVault`, `test_setDefaultWeights_rejectsDuplicateVault` and `RouterGovernance.t.sol::test_applyReceipt_revertsOnDuplicateVault` |
| HR-L-10 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter, RouterGovernance, VaultRegistry | #920 | Self-administered ADMIN_ROLE no floor; shared `AdminFloorAccessControl` forbids dropping to zero (open at HR-0618 HEAD, fixed by #920) |
| HR-L-11 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter | #933 | `rescueUsdc` was an unconditional admin sweep, first accepted by design. Re-dispositioned 2026-10-15 (SR-1012-9): #933 deleted `rescueUsdc`. The only router asset move left is the permissionless `sweepForeignToken`, which reverts for USDC and pays only the timelock-set `quarantineAddress` (`PortfolioRouter.sweepForeignToken`, `PortfolioRouter.sol:660-663`). Pinned by `CustodyInvariantGuard.t.sol::test_INV1_noArbitraryRecipientRescueFunctions` and `PortfolioRouter.t.sol::test_sweepForeignToken_revertsForUsdc` |
| HR-L-12 | VA-0609/HR-0618 | Low | fixed | RobotMoneyGateway | #836 | `withdrawFromRouter` paymentId OP-prefix added; pinned |
| HR-L-13 | VA-0609/HR-0618 | Low | accepted-with-rationale | RobotMoneyGateway | — | `withdraw` pulls shares from agent not shareReceiver; WONTFIX-by-design, documented + test-covered in #836 |
| HR-L-14 | VA-0609/HR-0618 | Low | fixed | AccessRoles | #836 | Role-separation override honors DEFAULT_ADMIN_ROLE; pinned |
| HR-L-15 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | Removed assets rescuable if tokens reappear; pinned |
| HR-L-16 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | `maxDeposit`/`maxMint` honor caps/shutdown/pause; pinned |
| HR-L-17 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | `setMaxSlippageBps(0)` pool-fee floor; pinned |
| HR-I-1 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | — | Adapter array never compacted; bounded by MAX_ADAPTERS active cap. Re-checked 2026-10-15 (SR-1012-9): `MAX_ADAPTERS = 20` (`RobotMoneyVault.sol:76`) bounds ACTIVE entries only (`activeCount(b) >= maxAdapters` in the linked `VaultAdapterOps.addAdapter`, `VaultAdapterOps.sol:372`). Since core 1789 a re-add after removal appends a new entry (`RobotMoneyVault.addAdapter`, `RobotMoneyVault.sol:881-883`; body `VaultAdapterOps.sol:357-377`), so the array grows by one per governed remove and re-add. Each step is an `ADMIN_ROLE` (timelock) call |
| HR-I-2 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | — | Exit-fee dust floors to zero; accepted by design. Re-checked 2026-10-15 (SR-1012-9): unchanged (`_grossToNet`, `RobotMoneyVault.sol:727-729`; same mechanism as FS-VLT-23) |
| HR-I-3 | VA-0609/HR-0618 | Info | accepted-with-rationale | MorphoAdapter | — | `max` sentinel ignored; out-of-trust-model, vault never passes max. Re-checked 2026-10-15 (SR-1012-9): the one-argument `withdraw` still forwards `max` to Morpho (`MorphoAdapter.sol:121-136`). The min-out `withdraw` honours it and redeems every share (`:143-168`) |
| HR-I-4 | VA-0609/HR-0618 | Info | accepted-with-rationale | retired RM test token | — | approve race / infinite allowance; devnet token, not mainnet-ready. Retired 2026-10-05: contract deleted (core 1489) |
| HR-I-5 | VA-0609/HR-0618 | Info | accepted-with-rationale | UniswapV3PoolSlot0Stub | — | No chain-id guard; demo-only, fail-closed at vault |
| HR-I-6 | VA-0609/HR-0618 | Info | accepted-with-rationale | retired V4 adapter | — | No fee-on-transfer delta check; admin-curated input, out of trust model |
| HR-I-7 | VA-0609/HR-0618 | Info | accepted-with-rationale | VaultRegistry | — | Stores `asset` without 4626 cross-check; admin-only, router re-derives. Re-checked 2026-10-15 (SR-1012-9): unchanged (`VaultRegistry.registerVault`, `VaultRegistry.sol:246-261`). The router reads the vault's own `asset()` before it routes (`PortfolioRouter._requireRouterEligible`, `PortfolioRouter.sol:1398-1410`) |
| HR-I-8 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyGateway | — | Unbounded AgentPolicy whitelist arrays; owner-self-DoS, out of trust model |
| HR-I-9 | VA-0609/HR-0618 | Info | fixed | MockVault | #836 | Constructor asset-mismatch revert; pinned, not production-reachable |
| HR-I-10 | VA-0609/HR-0618 | Info | fixed | retired Chronicle adapter | #836 | Hardcoded `WAD*1e12` scaling documented + `UnknownPricePair` revert tests |
| HR-L3-D1 | HR-0618 | Low | fixed | BasketVault, lib/TickMath | #920 | Externalized NAV math via deploy-linked library (TickMath externalization #877); #920 adds linked-codehash assertion + totalAssets sanity probe |
| HR-L3-F1 | HR-0618 | Info | accepted-with-rationale | BasketVault | — | Per-leg sell flooring can dip redeem below preview; dust-bounded (<1¢), documented (ADR-0007) |
| HR-L3-F2 | HR-0618 | Info | accepted-with-rationale | RobotMoneyGateway | — | `revokeAgent` leaves rolling-window state uncleared; conservative, self-healing within window |
| HR-L3-D2 | HR-0618 | Info | fixed | script/AdapterBytecodeGuard | #922 | Stale natspec listed Passthrough; purged from natspec + forge-doc mirror, grep-guarded |
| HR-S-1 | HR-0618 | Info | dismissed-with-rationale | Slither (production source) | — | 0 High, 0 true-positive Medium; all hits known-safe patterns, no action |

> Note 2026-10-05 (core 1494): HR-L-1 above predates core 1494. Withdrawals are now never frozen, and `withdrawalsPaused` is deleted. A pause stops deposits only (`pauseDeposits()` / `unpauseDeposits()` / `depositsPaused()`, `DEPOSIT_PAUSER_ROLE`, `VaultStatus.DepositsPaused`, `DepositsArePaused`). The deployed v1 vault keeps its old code. The rows above are kept as written.

### CD-0602 — Confused-deputy / caller-supplied-identity audit

Defense-in-depth audit (SquidRouterModule class) of every fund-moving entrypoint
across the 6 core contracts. All entrypoints verdict SAFE — no caller-supplied
authority fund path, no `amountOutMin=0` path; all pools ADMIN-registered. The
audit is narrowly scoped to caller-supplied-identity (later liveness/DoS bugs
found by SR-0612 do not contradict it). Nothing to remediate.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| CD-GATEWAY | CD-0602 | Info | accepted-with-rationale | RobotMoneyGateway (10 entrypoints) | — | Authority always from `msg.sender`/policy, never calldata — SAFE |
| CD-ROUTER | CD-0602 | Info | accepted-with-rationale | PortfolioRouter (8 entrypoints) | — | `depositFor` receiver trusted because gateway is the trust boundary — SAFE |
| CD-GOV | CD-0602 | Info | accepted-with-rationale | RouterGovernance (7 entrypoints) | — | Role-gated / eligibility-checked — SAFE |
| CD-REGISTRY | CD-0602 | Info | accepted-with-rationale | VaultRegistry (4 entrypoints) | — | ADMIN_ROLE gated — SAFE |
| CD-VAULT | CD-0602 | Info | accepted-with-rationale | RobotMoneyVault (7 entrypoints) | — | Standard ERC-4626 + role gates — SAFE |
| CD-BASKET | CD-0602 | Info | accepted-with-rationale | BasketVault (6 entrypoints) | — | TWAP slippage floors + ADMIN pool registration — SAFE |
| CD-OVERALL | CD-0602 | Info | accepted-with-rationale | All 6 core contracts | — | No confused-deputy gaps; no amountOutMin=0 path, all pools ADMIN-registered |

### SR-0612 / DC-0606 — Remediation-drift review + deep-clean (grouped)

> These two snapshots are recorded as grouped rows: SR-0612 is the authoritative
> source and proves several DC-0606 "fixed" claims never landed on `dev`. Per-ID
> detail (SR-H1…SR-P2, DC VAULT/AC/RUST/FIND IDs) lives in the cited snapshots.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SR-0612-OPEN | SR-0612 | High–Medium | accepted-with-rationale | RobotMoneyGateway, PortfolioRouter, RobotMoneyVault, BasketVault, retired RWA vault, RouterGovernance, retired Chronicle adapter, AerodromeSwapAdapter | — | 4 High + 19 Medium + 14 Low + 10 Info open on `dev` (or with fixes only on an unmerged remediation branch); each a known, acknowledged risk pending the contract-security-remediation phases (#933/#958/#987). Re-checked 2026-10-15 (SR-1012): SR-M10 (keeper rebalance undoes an emergency drain) is fixed by core 1788, PR 1814 (row SR-1012-6). SR-M15 (duplicate adapter) is fixed by core 1789, QA D1 `83e1899a` (row SR-1012-2). SR-H4 is partly fixed: `forceRemoveAdapter` deactivates first and reads the adapter inside `try`, so a reverting adapter view no longer blocks its removal (`RobotMoneyVault.forceRemoveAdapter`, `RobotMoneyVault.sol:1104-1107`, body `VaultAdapterOps.forceRemoveAdapter`, `VaultAdapterOps.sol:502-512`; `RobotMoneyVault.t.sol::test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts`), and `setAdapterAllowed(false)` drops the adapter from NAV before its view is read (`totalAssets` reads an adapter only when `VaultAdapterOps.isCounted` holds, `RobotMoneyVault.sol:555`). The NAV loop still calls each counted adapter's view unguarded (`RobotMoneyVault.sol:556`). Every other grouped ID is re-verified per ID by QA plan v1 task S1 |
| SR-0612-P1 | SR-0612 | Process | accepted-with-rationale | docs/code-review/20260606-code-review-internal-claude.md | — | Audit/remediation drift: DC-0606 claimed fixes (VAULT-002, VAULT-006, ORA-001/AC-005, MEV-001, AC-006, GOV-001/AC-002, VaultRegistry asset check) never landed on `dev`; recorded so this ledger reflects landing status, not claimed status |
| DC-0606-LANDED | DC-0606 | High–Info | fixed | RobotMoneyVault, BasketVault, RobotMoneyGateway, RouterGovernance, retired Chronicle adapter, retired V4 adapter, explorer-indexer, rmpc, dapp | #836, #933, #958 | ~63 deep-clean findings landed (5 Critical/High + Medium/Low/Info) across the contract-security-remediation phases; excludes the 8 contradicted-by-SR-0612 claims (above) and the 4 deferred items (below) |
| DC-0606-DEFER | DC-0606 | Deferred | accepted-with-rationale | VaultRegistry, RouterGovernance, BasketVault/AgentTokenVault, admin-transfer surface | — | 4 deferred items (RMDA-003 stale cached status, GOV-003 execute() re-validation, VAULT-011 SHORTLIST_ADD_DELAY, AC-008 two-step admin transfer); NatSpec invariant added, full fix needs governance/interface upgrade. Re-checked 2026-10-15 (SR-1012-9): GOV-003 is moot because core 1698 deleted `RouterGovernance.execute()` with the rest of the voting path (QA C1a `92c8c84e`; `RouterGovernance.t.sol::test_noVotingSurface`). AC-008 stands: admin roles still move by `grantRole` then `renounceRole`, with only the last-admin floor (`lib/AdminFloorAccessControl.sol`, `lib/AdminFloorAccessControlCounter.sol`). It stays accepted: every admin role sits behind the Safe and the timelock, and no change is planned |

### AZ-0623 — TestMachine Azimuth automated scan (2026-06-23, 55 findings)

Automated scan at HEAD `35f28b3b` (branch `dev`). All 55 findings verified at HEAD;
confirmation rate 100% — atypically high. Verification and commentary (severity re-grades,
n-order chains, mainnet-blocking list) in
`docs/code-review/20260623-code-review-testmachine-azimuth.md` (§ "Verification commentary").
The earlier FS-0619 "consent is structural" dismissal of gateway access-control findings is
**re-classified** by AZ-GW-1: victim consent is to the gateway contract as spender, not to any
specific agent; the #751 router-layer guard does not address the gateway-level confused deputy.

| Finding ID | Source | Severity (orig→regrade) | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| AZ-GW-1 | AZ-0623 | Critical | fixed | RobotMoneyGateway, PortfolioRouter | #1084 | Gateway arbitrary shareReceiver drain: attacker creates permissionless policy with victim as shareReceiver; gateway calls redeemFor using victim's existing gateway approval as the allowance check passes. #751 guards router layer only. |
| AZ-BSK-1 | AZ-0623 | High | fixed | BasketVault | #1097 | Deposits minted shares against slippage-floor (discounted credit), not realized NAV; #1097 makes the floor a revert guard and credits realized NAV. |
| AZ-RTR-2 | AZ-0623 | High | fixed | PortfolioRouter | #1093 | Donated USDC could block deposits under the absolute-zero post-deposit invariant; #1093 snapshots the pre-pull balance so pre-existing donations are excluded. |
| AZ-BSK-2 | AZ-0623 | Medium→High | fixed | BasketVault, PortfolioRouter | #1097 | BasketVault _deposit/_withdraw overrides discarded the ERC4626 `shares`/`assets` args while OZ returned previewed values; #1097 returns the realized values. |
| AZ-GW-2 | AZ-0623 | Medium | accepted-with-rationale | RobotMoneyGateway, rmpc (get_agent.rs), dapp (AgentPoliciesPanel.tsx) | — | rmpc get-agent and dapp report allowance(agent, gateway); router withdrawals spend shareReceiver allowances. Operator sees wrong blast radius for router-withdrawal policies. |
| AZ-DAPP-1 | AZ-0623 | Medium | accepted-with-rationale | dapp (OnboardingWizard.tsx, AuthorizeTab.tsx), RobotMoneyGateway | — | Dapp onboarding and authorize tab call admin-only `authorizeAgent`; permissionless commit/reveal path not wired. Normal depositor cannot complete wizard. |
| AZ-RPC-1 | AZ-0623 | Medium | accepted-with-rationale | rmpc (deposit.rs, tx/mod.rs) | — | Deposit receipt timeout unconditionally clears the replay cache entry even though timeout ≠ tx failed; in-flight tx can succeed after entry deleted, allowing duplicate broadcast. |
| AZ-BSK-3 | AZ-0623 | Medium | fixed | BasketVault, RobotMoneyVault | #1098, #1664 (BasketVault); #1814, QA D3 `83e1899a` (RobotMoneyVault) | Deposits during adapter exclusion proceeded at reduced NAV. #1098 excluded idle USDC from the mint denominator, which over-minted after `emergencyUnwind` + `unpauseDeposits`; #1664 (C1-corrected) prices new shares against the full idle-inclusive pre-deposit NAV, `mulDiv(realizedDelta, supplyBefore + 10^18, taBefore + 1)`. Corrected 2026-10-15 (SR-1012-1, SR-1012-9): #1098 and #1664 changed BasketVault only, and SR-1012 reproduced the RobotMoneyVault path at `2c81c742`. That half is fixed by core 1788 (PR 1814): `maxDeposit` is 0 and deposits revert while any active adapter is ineligible (`maxDeposit`, `_depositsClosed`, `_anyActiveAdapterIneligible`, `RobotMoneyVault.sol:681-704`). Core 1820 (QA D3) sends recovery to the holders at the moment of exclusion (`RobotMoneyVault._syncExclusions`, `RobotMoneyVault.sol:1277-1281`; bodies `VaultAdapterOps.syncExclusions` and `VaultAdapterOps._credit`, `VaultAdapterOps.sol:439-463,766-778`; `ExclusionLedger.sol`). Pinned by `SecurityReviewPoc.t.sol::test_revokedAdapterWindowDepositBlocked` and `SecurityReviewRecheckVaultPoc.t.sol::test_f1_holderExitDuringWindowKeepsRecoveryClaim` |
| AZ-BSK-4 | AZ-0623 | Medium | accepted-with-rationale | BasketVault, dapp (DepositWithdrawTab.tsx) | — | Direct vault deposit/redeem paths have no on-chain minimum-output parameter; preview is advisory only. |
| AZ-BSK-5 | AZ-0623 | Medium | fixed | BasketVault | #1099 | Permissionless `reabsorbRemovedAsset` allowed MEV to sandwich NAV recovery; #1099 requires caller-supplied `minUsdcOut` slippage protection. |
| AZ-BSK-6 | AZ-0623 | Medium | accepted-with-rationale | BasketVault | — | Redemptions use only vault-wide slippage floor; no per-caller `minAssetsOut`; MEV can extract up to `maxSlippageBps` within the configured band. |
| AZ-REG-1 | AZ-0623 | Medium | fixed | VaultRegistry, BasketVault | #1092 | `VaultRegistry.setVaultStatus` wrapped the vault retire hook in empty try/catch; #1092 makes the retirement hook mandatory so non-Active status cannot leave deposits unpaused. |
| AZ-GW-3 | AZ-0623 | Medium | fixed | RobotMoneyGateway, PortfolioRouter | #1089 | Router withdrawal path skipped the `allowedSourceVaults` check when the array was empty, so an empty allowlist meant no restriction. Re-dispositioned 2026-10-15 (SR-1012-9): #1089 makes an empty list mean pinned-vault-only on the router path, matching the single-vault `withdraw` (`GatewayWithdrawOps.checkRouterWithdraw`, the linked body of `RobotMoneyGateway.withdrawFromRouter`'s checks, `GatewayWithdrawOps.sol:131-145`). Pinned by `GatewayRouter.t.sol::test_withdrawFromRouter_emptyAllowedSourceVaults_rejectsNonPinned` and `test_withdrawFromRouter_emptyAllowedSourceVaults_acceptsPinnedVault` |
| AZ-GOV-1 | AZ-0623 | Medium | fixed | RouterGovernance, dapp (GovernancePanel.tsx) | QA C1a `92c8c84e` (core 1698) | Hard 256-block OZ snapshot cap < MIN_VOTING_PERIOD on L2; voting UI broke for remaining voters before voting closed. Re-dispositioned 2026-10-15 (SR-1012-9): the history window was first raised to 100,000 blocks. Core 1698 then deleted the whole voting path: `RouterGovernance.sol` keeps only `setReceiptContract`, `applyReceipt`, `setDefaultWeights`, `clearVotedWeights` and `currentWeights`, and the dapp `GovernancePanel` is deleted. Pinned by `RouterGovernance.t.sol::test_noVotingSurface` |
| AZ-RPC-2 | AZ-0623 | Medium | accepted-with-rationale | rmpc (withdraw.rs, withdraw_router.rs) | — | Deposit path has local replay-cache protection; withdraw paths do not; duplicate withdrawals can be signed if first tx still pending. |
| AZ-LOW | AZ-0623 | Low (11 findings) | accepted-with-rationale | RobotMoneyGateway, rmpc, dapp, PortfolioRouter | — | Deposit-lookup misses router-path events; destination selector allows non-Active vaults; off-chain feature flags not on-chain enforced; permissionless agent-address reservation; policy expiry at exact timestamp; receipt not bound to broadcast tx; router-withdrawal wall-clock deadline; router-withdrawal zero slippage floors; keystore file permissions; share-price overflow silently saturated; vault-selector gate races during status load. All low-severity, no existing fixes. Update 2026-10-15: the permissionless agent-address reservation is fixed by core 1791 (row SR-1012-7) |
| AZ-INFO | AZ-0623 | Info (29 findings) | accepted-with-rationale | all components | — | Audit log rotation not cross-process synchronized; Base fee cap / priority floor incompatibility; Chronicle NAV freshness not checked in-scope; plus 26 additional info-class observations. Accepted background risk. |

### SR-1012 — Smart-contract security review (2026-10-12, 9 findings)

Internal adversarial review of the 28 production contracts at baseline `2c81c742`
(`docs/code-review/20261012-security-review.md`, PR 1787, issue #1792). It reproduced each
finding against that baseline. Row `SR-1012-N` is the review's finding heading `### N.`, and
`scripts/check-audit-ledger.sh` fails when a heading has no row or a row has no heading.
`SR-1012-V4` records the review's open V4 sampling item, which has no number.

The dispositions below were re-checked against source on 2026-10-15, on branch
`qa/test-merge-v1`. A fix that landed only on that branch names its QA plan v1 task
(`docs/development/qa-plan-v1.md`) and its commit. A merged fix names its PR. Line numbers
are on that branch after QA plan P1 moved the vault, router and gateway bodies into the
linked libraries (ADR-0014 §9: `VaultAdapterOps`, `BasketSwapOps`, `GatewayAuth`,
`GatewayWindows`, `GatewayWithdrawOps`). Each source cite also names its symbol, so a cite
that drifts can be found again by name.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SR-1012-1 | SR-1012 | Medium | fixed | RobotMoneyVault, ExclusionLedger | #1814 (core 1788); QA D3 `83e1899a` (core 1820) | Deposits stayed open while a funded adapter was excluded from NAV, so new shares took a slice of the later recovery, and holders who exited during the exclusion lost theirs. Core 1788 closes `deposit` and `mint` while any active adapter is ineligible (`maxDeposit`, `_depositsClosed`, `RobotMoneyVault.sol:681-704`), and keeper `rebalance` skips the excluded adapter (`RobotMoneyVault.sol:980-1008`; pull leg `VaultAdapterOps.rebalancePull`, `VaultAdapterOps.sol:521`). Core 1820 opens an `ExclusionLedger` record with a holder snapshot at exclusion. Every recovery path credits that record (`RobotMoneyVault._syncExclusions`, `RobotMoneyVault.sol:1277-1281`; `VaultAdapterOps.syncExclusions` and `VaultAdapterOps._credit`, `VaultAdapterOps.sol:439-463,766-778`), and exiters keep their claim. A redeem that would pay 0 USDC during the exclusion reverts `ZeroPayoutDuringExclusion` (`RobotMoneyVault._withdraw`, `RobotMoneyVault.sol:784-786`). Pinned by `SecurityReviewPoc.t.sol::test_revokedAdapterWindowDepositBlocked`, `SecurityReviewRecheckVaultPoc.t.sol::test_f1_keeperRebalanceSkipsRevokedAdapter`, `test_f1_holderExitDuringWindowKeepsRecoveryClaim` and `RobotMoneyVault.t.sol::test_exclusionRecoveryPaidProRataToSnapshot`. Corrects AZ-BSK-3 for this family |
| SR-1012-2 | SR-1012 | Medium | fixed | RobotMoneyVault | QA D1 `83e1899a` (core 1789) | `addAdapter` accepted an address an active entry already held, so `totalAssets()` counted its balance twice and early redeemers took the excess. `addAdapter` now reverts `AdapterAlreadyActive` when any active entry holds the address (`RobotMoneyVault.addAdapter`, `RobotMoneyVault.sol:881-883`; check in `VaultAdapterOps.addAdapter`, `VaultAdapterOps.sol:367-371`). A re-add after `removeAdapter` or `forceRemoveAdapter` appends a new entry and counts the balance once. Same mechanism as SR-M15 and L-002. Pinned by `RobotMoneyVault.t.sol::test_addAdapter_revertsWhenAdapterAlreadyActive`, `SecurityReviewRecheckVaultPoc.t.sol::test_f2_eachHolderRedeemsOwnBackingAfterDuplicateRefused` and `test_f2_reAddAfterRemoveAdapterCountsBalanceOnce` |
| SR-1012-3 | SR-1012 | Low | fixed | RobotMoneyGateway, InvestmentCommitteePolicy, explorer-indexer | #1818 (core 1790; `897f5b10`, `e7a511cd`); QA A2 `92c8c84e` | A self-registered gateway agent could file a committee signal under another member's address. `committeeVoteSubmit` now reverts `CommitteeAgentNotCaller` when `p.agent != msg.sender` (`RobotMoneyGateway.committeeVoteSubmit`, `RobotMoneyGateway.sol:1357`). The indexer's tilt counts one latest, fresh, verified signal per active member and vault (`committee_tilts`, `services/explorer-indexer/src/db.rs:99-131`). QA A2 flipped the review's PoCs to assert the refusal: `SecurityReviewCommitteePoc.t.sol::test_selfRevealedAgentCannotImpersonateCommitteeMember`. Residual review limit: HTTP verification and dashboard rendering were not tested end to end |
| SR-1012-4 | SR-1012 | Imminent retirement (no severity) | fixed | RouterGovernance, explorer-indexer, dapp | QA C1a `92c8c84e`; C1 client and indexer removal `2b5d9c4a` (core 1698) | One voter met quorum under the example sheet values (`MIN_QUORUM_THRESHOLD` compared with power, not voters). Core 1698 deleted the propose, vote and execute path with its quorum: the weight setter keeps `setReceiptContract`, `applyReceipt`, `setDefaultWeights`, `clearVotedWeights` and `currentWeights` (`RouterGovernance.sol:130-229`). The dapp `GovernancePanel` and the indexer proposal tables are gone (migration `0023_drop_governance_voting.sql`). Pinned by `RouterGovernance.t.sol::test_noVotingSurface`. The Base 8453 test deployment (Deploy 2, core `78c50cbd`) predates this change, so the final deployment's own bytecode is what proves the surface is gone |
| SR-1012-5 | SR-1012 | Medium | accepted-with-rationale | RobotMoneyVault | — | Open. `forceRemoveAdapter` (EMERGENCY, no timelock) writes a funded adapter off NAV. Exits during the write-off are underpaid, and stayers gain if ADMIN re-adds the adapter (`RobotMoneyVault.forceRemoveAdapter`, `RobotMoneyVault.sol:1104-1107`; body `VaultAdapterOps.sol:502-512`). Still reproduced by `SecurityReviewRecheckVaultPoc.t.sol::test_O1a_forceRemoveAllFunded_redeemBurnsSharesForZero` and `test_O1b_forceRemovePartial_exitsUnderpaidStayersOverpaid`. Core 1820 narrows it: when the adapter was excluded first, force removal closes its exclusion record and the loss falls on the snapshot holders only. Tracked by #1705 Q2/C6. For the mainnet test the lever is named per vault (`scripts/deploy/stage-table.json` `emergencyLevers`, QA E9). Who may finalize a loss, how later recoveries are attributed, and caller-set minimum proceeds are decided before the final deployment. Withdrawals stay never frozen |
| SR-1012-6 | SR-1012 | Info (Medium if a keeper is granted) | fixed | RobotMoneyVault, publish-contracts verifier | #1814 (core 1788); QA `83e1899a` (verifier) | A keeper `rebalance` could re-deploy emergency-drained USDC. `rebalance` now reverts while deposits are paused or the vault is shut down, and skips ineligible adapters (`RobotMoneyVault.rebalance`, `RobotMoneyVault.sol:980-1008`). Pinned by `SecurityReviewRecheckVaultPoc.t.sol::test_O2_keeperRebalanceBlockedAfterEmergencyWithdraw`. The stage 12 verifier fails when any address holds `KEEPER_ROLE` on the vault (`publish-contracts/src/verify/index.ts:510-515`, label `KEEPER_ROLE has no holder`, #1705 C5). Same mechanism as SR-M10 |
| SR-1012-7 | SR-1012 | Low | fixed | RobotMoneyGateway, rmpc | QA D2 `83e1899a` (core 1791) | Any caller could commit and reveal authorization for an unowned agent address and become its policy owner. A caller without `ADMIN_ROLE` that names an agent other than itself must now pass the agent's EIP-712 consent (`AgentConsent(agent, owner, shareReceiver, nonce)`), or `revealAuthorization` reverts `InvalidAgentConsent` (`RobotMoneyGateway._authorizeAgentInternal`, `RobotMoneyGateway.sol:582-589`; check `GatewayAuth.requireAgentConsent`, `GatewayAuth.sol:94-119`). `releaseAgent` frees an address an `ADMIN_ROLE` caller bound without consent (`RobotMoneyGateway.sol:640`). Pinned by `SecurityReviewRecheckCommitteePoc.t.sol::test_permissionlessRevealCannotSquatThirdPartyAgentAddress`, `GatewayAgentPolicyAuthorization.t.sol::test_revealAuthorization_consentBoundToGatewayChainAndNonce` and `test_releaseAgent_bindingWithoutConsent_clearsAndFreesAddress` |
| SR-1012-8 | SR-1012 | Low | fixed | PortfolioRouter, RouterGovernance | QA C1a `92c8c84e` (core 1698) | Router weight vectors accepted duplicate vault addresses. `setWeights` and `_setDefaultWeights` now revert `DuplicateVault` (`PortfolioRouter.sol:508,595`, helper `_requireNoDuplicateBefore` at `:1388-1392`), and `applyReceipt` writes through `setWeights`. Previously HR-L-9 (now `fixed`). Pinned by `PortfolioRouter.t.sol::test_setWeights_rejectsDuplicateVault` and `RouterGovernance.t.sol::test_applyReceipt_revertsOnDuplicateVault` |
| SR-1012-9 | SR-1012 | Info | fixed | docs/audits.md, docs/architecture.md, docs/technical/smart-contract-invariants.md, docs/technical/smart-contracts.md | QA W2 (this ledger); QA W1; QA D1 `83e1899a`; #1814 | Audit dispositions and docs disagreed with source. Each item is reconciled: AZ-BSK-3 names the RobotMoneyVault fix; AZ-GW-3 is `fixed` (#1089); AZ-GOV-1 is `fixed` (core 1698); HR-L-11 is `fixed` (#933); HR-L-9 is `fixed` (SR-1012-8). The NC-8 entry names the stable-family rule (`smart-contract-invariants.md` LIFE-6, QA D1), and every "Enforced at" entry there names shipped vault code instead of the deleted ADR-0010 and Chronicle symbols (QA W3). The open executor is stated as shipped (`architecture.md` §4.5, "EXECUTOR_ROLE is open", QA W1). The allowlist docs name the NAV exclusion and the core 1820 recovery claim (`smart-contracts.md` §3.4, the `adapterAllowed` row and the two paragraphs after the table, corrected by QA W2; `RobotMoneyVault.setAdapterAllowed` NatSpec, `RobotMoneyVault.sol:885-921`). The review's unverified rows (SR-H4, FS-VLT-10/21/22/23/27, HR-I-1/2/3/7, FORCEREMOVE-001, DC-0606-DEFER GOV-003 and AC-008, SR-0612-OPEN) each carry a 2026-10-15 re-check with a source line above |
| SR-1012-V4 | SR-1012 | Unassessed | accepted-with-rationale | UniswapV4PriceRecorder, BasketVault, lib/BasketViews | QA D5 `83e1899a` (mitigation) | Open review item, not a numbered finding. A transient tick held without an honest record displaces the recorder mean for the full window. QA D5 (core 1793) adds a sell anchor: a V4-leg USDC redeem reverts `SpotBelowSellAnchor` when the live price sits more than `navDeviationGuardBps` under the 4-hour mean (`BasketViews.checkSellAnchor`), and the recorder ring grows to 7,201 slots. The measured residual is about 4.5% within 30 minutes of a hold, under the 5% bar of QA decision D2 (`docs/technical/recorder-manipulation-1793.md`). `redeemInKind` is unaffected. Accepted for the mainnet test; a stronger price source is decided before the final deployment |

### Gap analysis — process & coverage backlog (20260607-code-review-internal-claude-gap-analysis.md)

> The gap analysis enumerates 50 tracked-as-future-work items (issues #643–#692),
> not contract bugs. SECURITY-003 ("No audit ledger") is resolved by this issue
> (#1010). The remainder are open, each tracked by its GitHub issue.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SECURITY-003 | 20260607-code-review-internal-claude-gap-analysis.md | Medium | fixed | docs/audits.md, SECURITY.md | #1013, #1014 | "No audit ledger" — resolved by creating this `docs/audits.md` and the repo-root `SECURITY.md` (issue #1010) |
| SECURITY-001 | 20260607-code-review-internal-claude-gap-analysis.md | Medium | fixed | SECURITY.md | #1013, #1014 | "No SECURITY.md at repo root" — resolved by creating repo-root `SECURITY.md` (tracking issue #643) |
| GAP-BACKLOG | 20260607-code-review-internal-claude-gap-analysis.md | Critical–Low | accepted-with-rationale | architecture/security-model/CI/dapp/rmpc surfaces | — | The remaining ~48 gap items (#643–#692, e.g. MAINNET-001, WATCHDOG-001, CSP-001, bug-bounty SECURITY-002) are acknowledged future-work, each tracked by its GitHub issue; a coverage backlog, not a per-contract vulnerability. Re-checked 2026-10-15 (SR-1012-9): FORCEREMOVE-001 (loss path untested) is now covered by `RobotMoneyVault.t.sol::test_forceRemoveAdapter_deactivatesAdapterAndEmitsCorrectLoss`, `test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts` and `SecurityReviewRecheckVaultPoc.t.sol::test_O1a_forceRemoveAllFunded_redeemBurnsSharesForZero`; the loss attribution itself stays open as SR-1012-5 |

## Finding-disposition log

<!--
  §9 "Dismissed audit finding later exploited (Venus-class)" + §14 "Near-miss
  dismissal": every dismissed-with-rationale and accepted-with-rationale finding
  must be revisitable before a major change to the relevant code path. This log
  records the dismissed/accepted findings grouped by the snapshot that triaged
  them, the second-reviewer source (each verification is itself an independent
  multi-reviewer pass), and the code path to revisit. Per-finding rationale is in
  the register above.
-->

Every `dismissed-with-rationale` and `accepted-with-rationale` finding in the
register must be revisited before any major change to its code path (§9, §14
"Near-miss dismissal"). The dispositions were each set by an independent
multi-reviewer verification pass (the "Second reviewer" column names that pass);
the per-finding rationale lives in the register above.

| Finding group | Disposition | Second reviewer (verification pass) | Revisit-before path |
|---|---|---|---|
| FS-0619 dismissed (FS-IDX-9, FS-WD-3, FS-RTR-3/4, FS-VLT-2/4/6/7/11/14/16/24/25, FS-RPC-6/17, FS-HARN-1/3/4/7/8/9, FS-DAPP-3) | dismissed-with-rationale | 20260619-code-review-internal-claude-scan-verification.md (7 reviewer passes) | The named component before any change to indexer/watchdog/router/gateway/vault/adapter/rmpc/harness/dapp logic those IDs touch |
| FS-0619 accepted-open (FS-VLT-10, FS-RPC-11 + all FS-* not fixed/dismissed) | accepted-with-rationale | 20260619-code-review-internal-claude-scan-verification.md (7 reviewer passes) | The named component before any change to that finding's code path; FS-VLT-10 / FS-RPC-11 are CONFIRMED-open with no landed fix — close before mainnet |
| MC-0619 accepted/dismissed (MC-F-12, MC-F-18, MC-F-19) | accepted-with-rationale / dismissed-with-rationale | 20260619-code-review-pekshield.md (4 reviewer passes) | PortfolioRouter cap config; IUpstreamMonitor wiring; Slither suppressions |
| HR-0618 accepted (HR-M-10 bypass-half, HR-L-13, HR-I-1…I-8, HR-L3-F1/F2; HR-L-9 and HR-L-11 are `fixed` since 2026-10-15) | accepted-with-rationale | 20260618-code-review-internal-claude.md (double-checked second pass) | Governance `setWeights`/admin-floor; vault redeemFor/rescue paths; adapter sentinel/oracle scaling before any major change |
| HR-0618 dismissed (HR-S-1) | dismissed-with-rationale | 20260618-code-review-internal-claude.md + Slither 0.11.5 triage | Production Solidity before re-running Slither / changing suppressions |
| CD-0602 SAFE verdicts (all CD-*) | accepted-with-rationale | 20260602-code-review-internal-claude.md | Any fund-moving entrypoint before introducing caller-supplied authority or a zero-slippage swap path |
| SR-0612 open findings (SR-0612-OPEN, SR-0612-P1) | accepted-with-rationale | 20260612-code-review-internal-claude.md | The contract-security-remediation phases must land the open SR-* fixes before mainnet; verify landing, not claimed status |
| DC-0606 deferred (DC-0606-DEFER) | accepted-with-rationale | 20260606-code-review-internal-claude.md + 20260612-code-review-internal-claude.md cross-check | Registry status caching, RouterGovernance execute() re-validation, shortlist delay, admin transfer before those upgrades |
| Gap-analysis backlog (GAP-BACKLOG) | accepted-with-rationale | 20260607-code-review-internal-claude-gap-analysis.md | Resolve each #643–#692 tracking issue before the dependent launch gate (mainnet deploy, public dapp, bucket-B/C) |
| AZ-0623 accepted-open (all AZ-* except AZ-GW-1, AZ-GW-3, AZ-GOV-1, AZ-BSK-1/2/3/5, AZ-RTR-2, AZ-REG-1) | accepted-with-rationale | 20260623-code-review-testmachine-azimuth.md §Verification commentary (2026-06-23 in-context pass) | Re-evaluate accepted AZ findings before changes to their named paths. AZ-GW-3 was mainnet-blocking until #1089 fixed it (re-checked 2026-10-15, SR-1012-9). FS-0619 "consent is structural" dismissal was superseded by AZ-GW-1, which #1084 remediated. |
| SR-1012 accepted-open (SR-1012-5, SR-1012-V4) | accepted-with-rationale | 20261012-security-review.md (adversarial re-check pass with reproductions) + 2026-10-15 source re-check on `qa/test-merge-v1` | `forceRemoveAdapter` and every EMERGENCY lever before the #1705 Q2/C6 decision lands; `UniswapV4PriceRecorder`, `BasketViews.checkSellAnchor` and the recorder ring before the final deployment's price-source decision |
