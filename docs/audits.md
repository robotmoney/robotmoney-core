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
  (REVIEW_KEYS in the script; SR-1012 = 20261012-security-review.md;
  SR-1015 = 20261015-review-security-claude.md) and
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
    SR-1015 = docs/code-review/20261015-review-security-claude.md
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
| `gateway/RobotMoneyGateway.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | — |
| `gateway/AccessRoles.sol` | VA-0609, HR-0618, MC-0619, CD-0602 | Audited | — |
| `ConsensusRecommendationReceipt.sol` | none | Not separately audited | Investment-committee receipt contract; no snapshot in docs/code-review/ covers it. Launch exception B2 granted 2026-10-06 by the owner. Moved out of `contracts/gateway/` to `contracts/` (1906, SYS-1); the retired slot 0 is renamed `_retiredWriterSlot` and its getter `gateway()` is dropped, storage layout unchanged. Post-audit change (1620): inherits `AdminFloorAccessControl` and floors `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`; revoking or renouncing the last holder of either role reverts `LastAdminFloor`; a grant then renounce still hands the role over. The gateway binds this contract as an immutable, so a gateway redeploy needs a new copy of it |
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
| `lib/GovernedUUPS.sol` | none | Not separately audited | Issue 1808: `GovernedUUPS` (the UUPS entry points every proxied core contract inherits) and the linked `GovernedUpgrade` library (timelock-only `upgradeToAndCall`, target-bound one-way `freezeUpgrades`, ERC-7201 storage). New upgrade authority surface: needs an external audit before any proxied deployment holds user funds on 8453 (docs/technical/contract-upgradeability-plan.md) |
| `lib/GatewayWindows.sol` | VA-0609, HR-0618 (via the gateway rolling-window path, GW-4 / NC-7) | Audited logic, moved | Issue 1808: the gateway's rolling-window ring buffer moved unchanged into this linked library so the proxied gateway fits EIP-170. The move (DELEGATECALL, storage-pointer arguments) is not yet re-reviewed |
| `lib/RobotMoneyVaultOps.sol` | VA-0609, HR-0618 (via the rmUSDC emergency and drift paths) | Audited logic, moved | Issue 1808: rmUSDC's emergency drains, the `adminRebalance` pull, `getAdapterInfo` and `getAdapterDrift` moved unchanged into this linked library so the proxied vault fits EIP-170. Not yet re-reviewed |
| `lib/BasketSwaps.sol` | HR-0618, MC-0619 (via the BasketVault swap and emergency-unwind paths) | Audited logic, moved | Issue 1808: the basket swap executor, `emergencyUnwind`, `emergencyUnwindWithOverride` and `reabsorbRemovedAsset` moved unchanged into this linked library so the proxied basket family fits EIP-170. Not yet re-reviewed |

> Post-audit change (issue 1808): every proxied core contract above (`RobotMoneyVault`, the three
> basket vaults, `VaultRegistry`, `PortfolioRouter`, `RobotMoneyGateway`, `InvestmentCommitteePolicy`,
> `ConsensusRecommendationReceipt`, `RouterGovernance`) now initializes through `initialize` behind its
> own ERC-1967 proxy, on OpenZeppelin's upgradeable bases (v5.0.2), with constructor immutables moved to
> storage. None of the reports above covers the proxy form; it needs an external audit before a proxied
> deployment holds user funds on 8453. The live Base 8453 contracts are direct deployments and unchanged.

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
> | `ConsensusRecommendationReceipt.sol` (then under `gateway/`), `gateway/InvestmentCommitteePolicy.sol`, `FeatureFlags.sol` | Comments only: they name the one-call `applyReceipt`, which releases a receipt through the weight setter (core 1698) | QA C1a `92c8c84e` |
> | `VaultRegistry.sol` | The unused `IExactnessVault.allExact()` read is deleted | `83e1899a` |
> | `vaults/BasketVault.sol`, `lib/BasketViews.sol`, `lib/BasketAssetConfigGuard.sol` | Sell anchor on V4 legs (core 1793). One dust rule on every sell path. Emergency-unwind guard setter | QA D5, D6, D7 in `83e1899a` and `2b5d9c4a` |
> | The nine proxied contracts (`RobotMoneyVault.sol`, the three basket kinds through `vaults/BasketVault.sol`, `PortfolioRouter.sol`, `VaultRegistry.sol`, `gateway/RobotMoneyGateway.sol`, `gateway/InvestmentCommitteePolicy.sol`, `ConsensusRecommendationReceipt.sol` (then under `gateway/`)) and `RouterGovernance.sol` | Superseded by dev's #1832 design (merge 2026-10-15). Each proxied contract is a UUPS implementation behind its own ERC-1967 proxy (core 1808, ADR-0014, `lib/GovernedUUPS.sol`): constructors became initializers and only the timelock can upgrade or freeze. QA's own upgrade implementation (`GovernedUpgrade`, `ExclusionLedgerFactory`, the `VaultAdapterOps`, `BasketSwapOps`, `GatewayAuth` and `GatewayWithdrawOps` libraries, QA P1 and P3) was dropped. Its adapter logic lives in dev's `lib/RobotMoneyVaultOps.sol` | QA P1 and P3 (dropped), dev #1832 |

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
| FS-VLT-8 | FS-0619 | Medium→down | accepted-with-rationale | RobotMoneyVault | QA security round 1 (`qa/test-merge-v1`) | Idle-first withdrawals; matches HEAD. Re-dispositioned 2026-10-15 (security round 1): not benign while an illiquid adapter still counts in NAV, because `emergencyWithdraw` moves the healthy adapters to idle and early redeemers then take full NAV from idle while the haircut falls on the holders who stay. Idle-first stays; the order is fixed instead: `EMERGENCY_ROLE` now excludes the adapter first (`RobotMoneyVault.emergencyExcludeAdapter`, exclude-only, opens the exclusion record in the same call), then drains. Pinned by `RobotMoneyVault.t.sol::test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity` |
| FS-VLT-9 | FS-0619 | Medium | accepted-with-rationale | BasketVault | — | Inactive asset entries consume basket capacity; low impact |
| FS-VLT-10 | FS-0619 | Medium | accepted-with-rationale | MorphoAdapter | — | Morpho reports illiquid shares as withdrawable; CONFIRMED at HEAD — `totalAssets()` still `convertToAssets(shares)` with no maxWithdraw cap, no fix landed. Re-checked 2026-10-15 (SR-1012-9): unchanged at `MorphoAdapter.sol:197-200`; still open, close before mainnet |
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
| FS-VLT-21 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | `redeem()` return diverges from USDC transferred; confirmed, minor. Re-checked 2026-10-15 (SR-1012-9): `_withdraw` pays the receiver exactly the returned `assets` and sends the exit fee separately (`RobotMoneyVault._withdraw`, `RobotMoneyVault.sol:805,808`), so the vault's USDC outflow is `assets + fee` while `redeem` returns `assets` (ERC-4626 net semantics) |
| FS-VLT-22 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | Exact-asset withdraw overcharges fee (ceil gross-up); ±1 unit dust. Re-checked 2026-10-15 (SR-1012-9): unchanged, `_netToGross` rounds up (`RobotMoneyVault.sol:742-745`) |
| FS-VLT-23 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | Exit fee rounds to zero on dust chunks; ±1 unit dust. Re-checked 2026-10-15 (SR-1012-9): unchanged, `_grossToNet` floors the fee (`RobotMoneyVault.sol:738-740`) |
| FS-VLT-24 | FS-0619 | Medium→down | dismissed-with-rationale | RobotMoneyVault | — | "maxWithdraw unwithdrawable" refuted; L-1 floor fix is a counter-example |
| FS-VLT-25 | FS-0619 | Low→Medium | dismissed-with-rationale | RobotMoneyVault | — | "Emergency-unwind deposit-pause uncleanable" refuted; `emergencyUnwind` sets only `depositsPaused`, already cleared by Pausable-independent `_setDepositsPaused(false)` |
| FS-VLT-26 | FS-0619 | Low | accepted-with-rationale | BasketVault | — | Dust donations block asset removal; confirmed, minor |
| FS-VLT-27 | FS-0619 | Low→Info | accepted-with-rationale | RobotMoneyVault | — | `decimals()=6` vs `_decimalsOffset()=18`; documented. Re-checked 2026-10-15 (SR-1012-9): unchanged and documented in the NatSpec of `decimals` and `_decimalsOffset` (`RobotMoneyVault.sol:494-536`) |
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
| HR-L-9 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter, RouterGovernance | QA C1a `92c8c84e` (core 1698) | `setWeights` accepted duplicate vault entries; admin-gated, accepted until SR-1012-8 raised it again. Re-dispositioned 2026-10-15: `setWeights` and `_setDefaultWeights` call `_requireNoDuplicateBefore` and revert `DuplicateVault` (`PortfolioRouter.sol:515,602`, helper `_requireNoDuplicateBefore` at `:1388-1392`), so `applyReceipt` cannot write a duplicate either. Pinned by `PortfolioRouter.t.sol::test_setWeights_rejectsDuplicateVault`, `test_setDefaultWeights_rejectsDuplicateVault` and `RouterGovernanceApplyReceipt.t.sol::test_duplicateVault_revertsOnSettersAndReceiptPath` |
| HR-L-10 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter, RouterGovernance, VaultRegistry | #920 | Self-administered ADMIN_ROLE no floor; shared `AdminFloorAccessControl` forbids dropping to zero (open at HR-0618 HEAD, fixed by #920) |
| HR-L-11 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter | #933 | `rescueUsdc` was an unconditional admin sweep, first accepted by design. Re-dispositioned 2026-10-15 (SR-1012-9): #933 deleted `rescueUsdc`. The only router asset move left is the permissionless `sweepForeignToken`, which reverts for USDC and pays only the timelock-set `quarantineAddress` (`PortfolioRouter.sweepForeignToken`, `PortfolioRouter.sol:667-670`). Pinned by `CustodyInvariantGuard.t.sol::test_INV1_noArbitraryRecipientRescueFunctions` and `PortfolioRouter.t.sol::test_sweepForeignToken_revertsForUsdc` |
| HR-L-12 | VA-0609/HR-0618 | Low | fixed | RobotMoneyGateway | #836 | `withdrawFromRouter` paymentId OP-prefix added; pinned |
| HR-L-13 | VA-0609/HR-0618 | Low | accepted-with-rationale | RobotMoneyGateway | — | `withdraw` pulls shares from agent not shareReceiver; WONTFIX-by-design, documented + test-covered in #836 |
| HR-L-14 | VA-0609/HR-0618 | Low | fixed | AccessRoles | #836 | Role-separation override honors DEFAULT_ADMIN_ROLE; pinned |
| HR-L-15 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | Removed assets rescuable if tokens reappear; pinned |
| HR-L-16 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | `maxDeposit`/`maxMint` honor caps/shutdown/pause; pinned |
| HR-L-17 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | `setMaxSlippageBps(0)` pool-fee floor; pinned |
| HR-I-1 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | — | Adapter array never compacted; bounded by MAX_ADAPTERS active cap. Re-checked 2026-10-15 (SR-1012-9): `MAX_ADAPTERS = 20` (`RobotMoneyVault.sol:80`) bounds ACTIVE entries only (`activeCount(b) >= maxAdapters` in the linked `RobotMoneyVaultOps.addAdapter`, `RobotMoneyVaultOps.sol:491-495`). Since core 1789 a re-add after removal appends a new entry (`RobotMoneyVault.addAdapter`, `RobotMoneyVault.sol:895-901`; body `RobotMoneyVaultOps.sol:481-512`), so the array grows by one per governed remove and re-add. Each step is an `ADMIN_ROLE` (timelock) call |
| HR-I-2 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | — | Exit-fee dust floors to zero; accepted by design. Re-checked 2026-10-15 (SR-1012-9): unchanged (`_grossToNet`, `RobotMoneyVault.sol:738-740`; same mechanism as FS-VLT-23) |
| HR-I-3 | VA-0609/HR-0618 | Info | accepted-with-rationale | MorphoAdapter | — | `max` sentinel ignored; out-of-trust-model, vault never passes max. Re-checked 2026-10-15 (SR-1012-9): the one-argument `withdraw` still forwards `max` to Morpho (`MorphoAdapter.sol:147-162`). The min-out `withdraw` honours it and redeems every share (`:143-168`) |
| HR-I-4 | VA-0609/HR-0618 | Info | accepted-with-rationale | retired RM test token | — | approve race / infinite allowance; devnet token, not mainnet-ready. Retired 2026-10-05: contract deleted (core 1489) |
| HR-I-5 | VA-0609/HR-0618 | Info | accepted-with-rationale | UniswapV3PoolSlot0Stub | — | No chain-id guard; demo-only, fail-closed at vault |
| HR-I-6 | VA-0609/HR-0618 | Info | accepted-with-rationale | retired V4 adapter | — | No fee-on-transfer delta check; admin-curated input, out of trust model |
| HR-I-7 | VA-0609/HR-0618 | Info | accepted-with-rationale | VaultRegistry | — | Stores `asset` without 4626 cross-check; admin-only, router re-derives. Re-checked 2026-10-15 (SR-1012-9): unchanged (`VaultRegistry.registerVault`, `VaultRegistry.sol:246-261`). The router reads the vault's own `asset()` before it routes (`PortfolioRouter._requireRouterEligible`, `PortfolioRouter.sol:1408-1432`) |
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
| SR-0612-OPEN | SR-0612 | High–Medium | accepted-with-rationale | RobotMoneyGateway, PortfolioRouter, RobotMoneyVault, BasketVault, retired RWA vault, RouterGovernance, retired Chronicle adapter, AerodromeSwapAdapter | — | 4 High + 19 Medium + 14 Low + 10 Info open on `dev` (or with fixes only on an unmerged remediation branch); each a known, acknowledged risk pending the contract-security-remediation phases (#933/#958/#987). Re-checked 2026-10-15 (SR-1012): SR-M10 (keeper rebalance undoes an emergency drain) is fixed by core 1788, PR 1814 (row SR-1012-6). SR-M15 (duplicate adapter) is fixed by core 1789, QA D1 `83e1899a` (row SR-1012-2). SR-H4 is partly fixed: `forceRemoveAdapter` deactivates first and reads the adapter inside `try`, so a reverting adapter view no longer blocks its removal (`RobotMoneyVault.forceRemoveAdapter`, `RobotMoneyVault.sol:1150-1155`, body `RobotMoneyVaultOps.forceRemoveAdapter`, `RobotMoneyVaultOps.sol:665-688`; `RobotMoneyVault.t.sol::test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts`), and `setAdapterAllowed(false)` drops the adapter from NAV before its view is read (`totalAssets` reads an adapter only when `RobotMoneyVaultOps.isCounted` holds, `RobotMoneyVault.sol:562`). The NAV loop still calls each counted adapter's view unguarded (`RobotMoneyVault.sol:563`). Every other grouped ID is re-verified per ID by QA plan v1 task S1 |
| SR-0612-P1 | SR-0612 | Process | accepted-with-rationale | docs/code-review/20260606-code-review-internal-claude.md | — | Audit/remediation drift: DC-0606 claimed fixes (VAULT-002, VAULT-006, ORA-001/AC-005, MEV-001, AC-006, GOV-001/AC-002, VaultRegistry asset check) never landed on `dev`; recorded so this ledger reflects landing status, not claimed status |
| DC-0606-LANDED | DC-0606 | High–Info | fixed | RobotMoneyVault, BasketVault, RobotMoneyGateway, RouterGovernance, retired Chronicle adapter, retired V4 adapter, explorer-indexer, rmpc, dapp | #836, #933, #958 | ~63 deep-clean findings landed (5 Critical/High + Medium/Low/Info) across the contract-security-remediation phases; excludes the 8 contradicted-by-SR-0612 claims (above) and the 4 deferred items (below) |
| DC-0606-DEFER | DC-0606 | Deferred | accepted-with-rationale | VaultRegistry, RouterGovernance, BasketVault/AgentTokenVault, admin-transfer surface | — | 4 deferred items (RMDA-003 stale cached status, GOV-003 execute() re-validation, VAULT-011 SHORTLIST_ADD_DELAY, AC-008 two-step admin transfer); NatSpec invariant added, full fix needs governance/interface upgrade. Re-checked 2026-10-15 (SR-1012-9): GOV-003 is moot because core 1698 deleted `RouterGovernance.execute()` with the rest of the voting path (QA C1a `92c8c84e`; `RouterGovernanceApplyReceipt.t.sol::test_noVotingSurface`). AC-008 stands: admin roles still move by `grantRole` then `renounceRole`, with only the last-admin floor (`lib/AdminFloorAccessControl.sol`, `lib/AdminFloorAccessControlCounter.sol`). It stays accepted: every admin role sits behind the Safe and the timelock, and no change is planned |

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
| AZ-BSK-3 | AZ-0623 | Medium | fixed | BasketVault, RobotMoneyVault | #1098, #1664 (BasketVault); #1814, QA D3 `83e1899a` (RobotMoneyVault) | Deposits during adapter exclusion proceeded at reduced NAV. #1098 excluded idle USDC from the mint denominator, which over-minted after `emergencyUnwind` + `unpauseDeposits`; #1664 (C1-corrected) prices new shares against the full idle-inclusive pre-deposit NAV, `mulDiv(realizedDelta, supplyBefore + 10^18, taBefore + 1)`. Corrected 2026-10-15 (SR-1012-1, SR-1012-9): #1098 and #1664 changed BasketVault only, and SR-1012 reproduced the RobotMoneyVault path at `2c81c742`. That half is fixed by core 1788 (PR 1814): `maxDeposit` is 0 and deposits revert while any active adapter is ineligible (`maxDeposit`, `_depositsClosed`, `_anyActiveAdapterBlocked`, `RobotMoneyVault.sol:691-715`). Core 1820 (QA D3) sends recovery to the holders at the moment of exclusion (`RobotMoneyVault._syncExclusions`, `RobotMoneyVault.sol:1337-1341`; bodies `RobotMoneyVaultOps.syncExclusions` and `RobotMoneyVaultOps._credit`, `RobotMoneyVaultOps.sol:569-588,1018-1028`; `ExclusionLedger.sol`). Pinned by `SecurityReviewPoc.t.sol::test_revokedAdapterWindowDepositBlocked` and `SecurityReviewRecheckVaultPoc.t.sol::test_f1_holderExitDuringWindowKeepsRecoveryClaim` |
| AZ-BSK-4 | AZ-0623 | Medium | accepted-with-rationale | BasketVault, dapp (DepositWithdrawTab.tsx) | — | Direct vault deposit/redeem paths have no on-chain minimum-output parameter; preview is advisory only. |
| AZ-BSK-5 | AZ-0623 | Medium | fixed | BasketVault | #1099 | Permissionless `reabsorbRemovedAsset` allowed MEV to sandwich NAV recovery; #1099 requires caller-supplied `minUsdcOut` slippage protection. |
| AZ-BSK-6 | AZ-0623 | Medium | accepted-with-rationale | BasketVault | — | Redemptions use only vault-wide slippage floor; no per-caller `minAssetsOut`; MEV can extract up to `maxSlippageBps` within the configured band. |
| AZ-REG-1 | AZ-0623 | Medium | fixed | VaultRegistry, BasketVault | #1092 | `VaultRegistry.setVaultStatus` wrapped the vault retire hook in empty try/catch; #1092 makes the retirement hook mandatory so non-Active status cannot leave deposits unpaused. |
| AZ-GW-3 | AZ-0623 | Medium | fixed | RobotMoneyGateway, PortfolioRouter | #1089 | Router withdrawal path skipped the `allowedSourceVaults` check when the array was empty, so an empty allowlist meant no restriction. Re-dispositioned 2026-10-15 (SR-1012-9): #1089 makes an empty list mean pinned-vault-only on the router path, matching the single-vault `withdraw` (`RobotMoneyGateway.withdrawFromRouter`, removed by issue 1889 with every agent withdrawal path). |
| AZ-GOV-1 | AZ-0623 | Medium | fixed | RouterGovernance, dapp (GovernancePanel.tsx) | QA C1a `92c8c84e` (core 1698) | Hard 256-block OZ snapshot cap < MIN_VOTING_PERIOD on L2; voting UI broke for remaining voters before voting closed. Re-dispositioned 2026-10-15 (SR-1012-9): the history window was first raised to 100,000 blocks. Core 1698 then deleted the whole voting path: `RouterGovernance.sol` keeps only `setReceiptContract`, `applyReceipt`, `setDefaultWeights`, `clearVotedWeights` and `currentWeights`, and the dapp `GovernancePanel` is deleted. Pinned by `RouterGovernanceApplyReceipt.t.sol::test_noVotingSurface` |
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
(`docs/development/qa-plan-v1.md`) and its commit. A merged fix names its PR. Rows that concerned
QA's own upgrade implementation read "superseded by dev's #1832 design (merge 2026-10-15)".
Line numbers are on the merged tree, where the vault bodies sit in `lib/RobotMoneyVaultOps.sol`
and the basket swaps in `lib/BasketSwaps.sol`. Each source cite also names its symbol, so a cite
that drifts can be found again by name.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SR-1012-1 | SR-1012 | Medium | fixed | RobotMoneyVault, ExclusionLedger | #1814 (core 1788); QA D3 `83e1899a` (core 1820) | Deposits stayed open while a funded adapter was excluded from NAV, so new shares took a slice of the later recovery, and holders who exited during the exclusion lost theirs. Core 1788 closes `deposit` and `mint` while any active adapter is ineligible (`maxDeposit`, `_depositsClosed`, `RobotMoneyVault.sol:691-715`), and keeper `rebalance` skips the excluded adapter (`RobotMoneyVault.sol:1003-1031`; pull leg `RobotMoneyVaultOps.rebalancePull`, `RobotMoneyVaultOps.sol:744-760`). Core 1820 opens an `ExclusionLedger` record with a holder snapshot at exclusion. Every recovery path credits that record (`RobotMoneyVault._syncExclusions`, `RobotMoneyVault.sol:1337-1341`; `RobotMoneyVaultOps.syncExclusions` and `RobotMoneyVaultOps._credit`, `RobotMoneyVaultOps.sol:569-588,1018-1028`), and exiters keep their claim. A redeem that would pay 0 USDC during the exclusion reverts `ZeroPayoutDuringExclusion` (`RobotMoneyVault._withdraw`, `RobotMoneyVault.sol:795-797`). Pinned by `SecurityReviewPoc.t.sol::test_revokedAdapterWindowDepositBlocked`, `SecurityReviewRecheckVaultPoc.t.sol::test_f1_keeperRebalanceSkipsRevokedAdapter`, `test_f1_holderExitDuringWindowKeepsRecoveryClaim` and `RobotMoneyVault.t.sol::test_exclusionRecoveryPaidProRataToSnapshot`. Corrects AZ-BSK-3 for this family |
| SR-1012-2 | SR-1012 | Medium | fixed | RobotMoneyVault | QA D1 `83e1899a` (core 1789) | `addAdapter` accepted an address an active entry already held, so `totalAssets()` counted its balance twice and early redeemers took the excess. `addAdapter` now reverts `AdapterAlreadyActive` when any active entry holds the address (`RobotMoneyVault.addAdapter`, `RobotMoneyVault.sol:895-901`; check in `RobotMoneyVaultOps.addAdapter`, `RobotMoneyVaultOps.sol:490-495`). A re-add after `removeAdapter` or `forceRemoveAdapter` appends a new entry and counts the balance once; since security round 1 a re-add after a funded `forceRemoveAdapter` first pays the adapter's balance into the entry's open exclusion record (SR-1012-5), so the new entry starts empty. Same mechanism as SR-M15 and L-002. Pinned by `RobotMoneyVault.t.sol::test_addAdapter_revertsWhenAdapterAlreadyActive`, `SecurityReviewRecheckVaultPoc.t.sol::test_f2_eachHolderRedeemsOwnBackingAfterDuplicateRefused` and `test_f2_reAddAfterRemoveAdapterCountsBalanceOnce` |
| SR-1012-3 | SR-1012 | Low | fixed | RobotMoneyGateway, InvestmentCommitteePolicy, explorer-indexer | #1818 (core 1790; `897f5b10`, `e7a511cd`); QA A2 `92c8c84e` | A self-registered gateway agent could file a committee signal under another member's address. `committeeVoteSubmit` now reverts `CommitteeAgentNotCaller` when `p.agent != msg.sender` (the entrypoint was deleted by issue 1888). The indexer's tilt counts one latest, fresh, verified signal per active member and vault (`committee_tilts`, `services/explorer-indexer/src/db.rs:99-131`). The committee suites that asserted the refusal were deleted with the committee (issue 1888). Residual review limit: HTTP verification and dashboard rendering were not tested end to end |
| SR-1012-4 | SR-1012 | Imminent retirement (no severity) | fixed | RouterGovernance, explorer-indexer, dapp | QA C1a `92c8c84e`; C1 client and indexer removal `2b5d9c4a` (core 1698) | One voter met quorum under the example sheet values (`MIN_QUORUM_THRESHOLD` compared with power, not voters). Core 1698 deleted the propose, vote and execute path with its quorum: the weight setter keeps `applyReceipt`, `setDefaultWeights`, `clearVotedWeights` and `currentWeights` (`RouterGovernance.applyReceipt`, `RouterGovernance.sol:161-215`); `router` and `receipts` are set once in `initialize` and have no setter. The dapp `GovernancePanel` and the indexer proposal tables are gone (migration `0025_drop_governance_voting.sql`). Pinned by `RouterGovernanceApplyReceipt.t.sol::test_noVotingSurface`. The Base 8453 test deployment (Deploy 2, core `78c50cbd`) predates this change, so the final deployment's own bytecode is what proves the surface is gone |
| SR-1012-5 | SR-1012 | Medium | fixed | RobotMoneyVault | QA security round 1 (`qa/test-merge-v1`) | Was: `forceRemoveAdapter` (EMERGENCY, no timelock) wrote a funded adapter off NAV. Exits during the write-off were underpaid, and stayers gained if ADMIN re-added the adapter; core 1820 only narrowed it, because force removal closed an open exclusion record and a re-add then put the stranded balance into NAV. Now a funded entry with no record gets one (snapshot of the share supply), a record closes (`ForceRemoved`) only when the adapter reports an empty balance, and `addAdapter` of the same address realises the balance into the still-open record before the new entry counts (`RobotMoneyVault.forceRemoveAdapter`, `RobotMoneyVault.sol:1150-1155`; body `RobotMoneyVaultOps.forceRemoveAdapter`, `RobotMoneyVaultOps.sol:665-688`; settle in `RobotMoneyVaultOps.addAdapter`, `RobotMoneyVaultOps.sol:481-512`). Pinned by `SecurityReviewRecheckVaultPoc.t.sol::test_O1a_forceRemoveAllFunded_exiterKeepsFullRecoveryClaim`, `test_O1b_forceRemovePartial_exiterAndStayerShareRecoveryProRata` and `RobotMoneyVault.t.sol::test_forceRemovedExcludedAdapter_reAddCreditsSnapshotRecord`. The lever stays named per vault for the mainnet test (`scripts/deploy/stage-table.json` `emergencyLevers`, QA E9; issue 1705 Q2/C6 decides narrowing). Withdrawals stay never frozen |
| SR-1012-6 | SR-1012 | Info (Medium if a keeper is granted) | fixed | RobotMoneyVault, publish-contracts verifier | #1814 (core 1788); QA `83e1899a` (verifier) | A keeper `rebalance` could re-deploy emergency-drained USDC. `rebalance` now reverts while deposits are paused or the vault is shut down, and skips ineligible adapters (`RobotMoneyVault.rebalance`, `RobotMoneyVault.sol:1003-1031`). Pinned by `SecurityReviewRecheckVaultPoc.t.sol::test_O2_keeperRebalanceBlockedAfterEmergencyWithdraw`. The stage 12 verifier fails when any address holds `KEEPER_ROLE` on the vault (`publish-contracts/src/verify/index.ts:510-515`, label `KEEPER_ROLE has no holder`, #1705 C5). Same mechanism as SR-M10 |
| SR-1012-7 | SR-1012 | Low | fixed | RobotMoneyGateway, rmpc | #1823 (core 1791); QA D2 `83e1899a` (dropped) | Any caller could commit and reveal authorization for an unowned agent address and become its policy owner. `revealAuthorization` for an agent other than the caller now needs the agent's own prior `commitAuthorization` over the caller and the exact calldata, or it reverts `OwnerConsentMissing`; the consent is cleared on use, and an agent that reveals for itself consents by calling (`RobotMoneyGateway.revealAuthorization`, `RobotMoneyGateway.sol:451-460`). This is dev's commit-based design (#1823). QA D2's EIP-712 consent (`AgentConsent`, `GatewayAuth.requireAgentConsent`, `releaseAgent`) was dropped at the merge. The suite that pinned it was deleted with the committee (issue 1888). |
| SR-1012-8 | SR-1012 | Low | fixed | PortfolioRouter, RouterGovernance | QA C1a `92c8c84e` (core 1698) | Router weight vectors accepted duplicate vault addresses. `setWeights` and `_setDefaultWeights` now revert `DuplicateVault` (`PortfolioRouter.sol:515,602`, helper `_requireNoDuplicateBefore` at `:1388-1392`), and `applyReceipt` writes through `setWeights`. Previously HR-L-9 (now `fixed`). Pinned by `PortfolioRouter.t.sol::test_setWeights_rejectsDuplicateVault` and `RouterGovernanceApplyReceipt.t.sol::test_duplicateVault_revertsOnSettersAndReceiptPath` |
| SR-1012-9 | SR-1012 | Info | fixed | docs/audits.md, docs/architecture.md, docs/technical/smart-contract-invariants.md, docs/technical/smart-contracts.md | QA W2 (this ledger); QA W1; QA D1 `83e1899a`; #1814 | Audit dispositions and docs disagreed with source. Each item is reconciled: AZ-BSK-3 names the RobotMoneyVault fix; AZ-GW-3 is `fixed` (#1089); AZ-GOV-1 is `fixed` (core 1698); HR-L-11 is `fixed` (#933); HR-L-9 is `fixed` (SR-1012-8). The NC-8 entry names the stable-family rule (`smart-contract-invariants.md` LIFE-6, QA D1), and every "Enforced at" entry there names shipped vault code instead of the deleted ADR-0010 and Chronicle symbols (QA W3). The open executor is stated as shipped (`architecture.md` §4.5, "EXECUTOR_ROLE is open", QA W1). The allowlist docs name the NAV exclusion and the core 1820 recovery claim (`smart-contracts.md` §3.4, the `adapterAllowed` row and the two paragraphs after the table, corrected by QA W2; `RobotMoneyVault.setAdapterAllowed` NatSpec, `RobotMoneyVault.sol:903-944`). The review's unverified rows (SR-H4, FS-VLT-10/21/22/23/27, HR-I-1/2/3/7, FORCEREMOVE-001, DC-0606-DEFER GOV-003 and AC-008, SR-0612-OPEN) each carry a 2026-10-15 re-check with a source line above |
| SR-1012-V4 | SR-1012 | Unassessed | accepted-with-rationale | UniswapV4PriceRecorder, BasketVault, lib/BasketViews | QA D5 `83e1899a` (mitigation) | Open review item, not a numbered finding. A transient tick held without an honest record displaces the recorder mean for the full window. QA D5 (core 1793) adds a sell anchor: a V4-leg USDC redeem reverts `SpotBelowSellAnchor` when the live price sits more than `navDeviationGuardBps` under the 4-hour mean (`BasketViews.checkSellAnchor`), and the recorder ring grows to 7,201 slots. The measured residual is about 4.5% within 30 minutes of a hold, under the 5% bar of QA decision D2 (`docs/technical/recorder-manipulation-1793.md`). `redeemInKind` is unaffected. Accepted for the mainnet test; a stronger price source is decided before the final deployment |

### SR-1015 — Security review, three rounds (2026-10-15, 69 findings)

Internal adversarial review of branch `qa/test-merge-v1` at base `9d9bb854` plus the uncommitted fixes of its own three rounds
(`docs/code-review/20261015-review-security-claude.md`, JSON summary `docs/code-review/20261015-review-security-claude.json`). Row `SR-1015-N` is the review's finding
heading `### N.` (JSON id `review-security-NNN`), and `scripts/check-audit-ledger.sh` fails when a heading has no row or a row has
no heading. A `fixed` row means fixed in the working tree of that branch and compile-checked only: no test has run, so
each row still needs Phase Q. The review folded nine cross-lens duplicates, so the 78 confirmed candidates are 69 rows.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SR-1015-1 | SR-1015 | High | fixed | CI release-rmpc.yml | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Actions cache poisoning of the attesting rmpc build. Fix: Removed the Swatinem/rust-cache step from the build job entirely, so no run of the attesting job restores or saves a cache. Compile-checked only; its tests have not run (Phase Q). Residual: Owner action: turn on immutable releases. |
| SR-1015-2 | SR-1015 | Medium | fixed | CI release-rmpc.yml | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Attesting release jobs ran actions at mutable refs. Fix: Every uses: in both release workflows is pinned to a full commit SHA with a version comment. Compile-checked only; its tests have not run (Phase Q). Residual: rust-toolchain.toml was not added. release-dapp.yml still uses a type=gha build cache in a job with packages: write. |
| SR-1015-3 | SR-1015 | Medium | fixed | CI release-rmpc.yml | QA security round 2 (`qa/test-merge-v1`, uncommitted) | aarch64 rmpc leg linked in a mutable cross image. Fix: The repo is public, so linux-arm64 now builds natively on the free GitHub-hosted ubuntu-24.04-arm runner. Compile-checked only; its tests have not run (Phase Q). Residual: Native arm64 builds raise the arm64 glibc floor, so Debian 11 and Ubuntu 20.04 arm64 lose prebuilt binaries. Dispatch one dry run on the new arm64 runner before the next rmpc-v tag. |
| SR-1015-4 | SR-1015 | Medium | fixed | CI suite-01-02-forge-tests.yml | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Layout --base anchored to the parent commit. Fix: New --release-anchor mode runs the same storage compare against every annotated production release/<version> tag in the clone. Compile-checked only; its tests have not run (Phase Q). Residual: Owner actions: protect refs/tags/release/* with an admin-only ruleset, because the anchor trusts those tags, and add required status checks on dev. |
| SR-1015-5 | SR-1015 | Low | fixed | dapp | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Withdraw tab hid the revoke for an unverified router. Fix: The Withdraw tab reads and offers a revoke of the share allowance to any configured router, also when that router failed its pins. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-6 | SR-1015 | Low | fixed | dapp | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Dapp blocked router deposits on any unavailable leg. Fix: The dapp no longer blocks a router deposit on an unavailable leg; the simulation is the revert gate and the preview shows renormalized legs. Compile-checked only; its tests have not run (Phase Q). Residual: docs/technical/portfolio-router-decisions.md sections 3.1 and 3.4 still say any unavailable leg reverts (stale scout doc, docs lane). |
| SR-1015-7 | SR-1015 | Medium | fixed | dapp | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Dapp vault and router pins hashed only the proxy runtime. Fix: New build-time pins VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH (JSON map) and VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-8 | SR-1015 | Medium | fixed | dapp | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Dapp router deposits skipped leg implementation checks. Fix: The write guard checks every leg vault's implementation before a router deposit and names a failing leg. Compile-checked only; its tests have not run (Phase Q). Residual: pinnedWriteTarget does not cover router.depositFor. The dapp never calls it today. |
| SR-1015-9 | SR-1015 | Low | fixed | dapp | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Config export told operators to pin the live implementation. Fix: The export writes proxy_implementation_hashes as values from the build's vault and router implementation pins (never live reads). Compile-checked only; its tests have not run (Phase Q). Residual: The export still writes one flat cross-address pin list (round 3 left the dapp-lane half of the pin retirement fix undone). |
| SR-1015-10 | SR-1015 | Medium | fixed | dapp | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Dapp writes never checked the logic behind proxies. Fix: The write guard re-reads each proxy's implementation before every send, drops the session cache and re-verifies the gateway implementation before each gateway write. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-11 | SR-1015 | Low | fixed | dapp | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Dapp exits disabled when gateway verification failed. Fix: vaultRedeem and routerRedeem previews are built with ok:true, an UNVERIFIED badge and a new PreviewSuccess.warning carrying the gateway cause. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-12 | SR-1015 | Low | fixed | explorer-api | QA security round 1 (`qa/test-merge-v1`, uncommitted) | /health stayed ok after the indexer stopped. Fix: Health now has since_success_secs, read on the DB clock from the newest successful run that has a cursor, the same row the watchdog uses. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-13 | SR-1015 | Low | fixed | explorer-api | QA security round 1 (`qa/test-merge-v1`, uncommitted) | /v1/vault/snapshots not bound to the served chain. Fix: The route binds the served chain id and answers 404 for any other chain. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-14 | SR-1015 | Low | accepted-with-rationale | rmpc | — | Swarm preflight checked the wrong IC policy and one role. Deferred. It needs new rmpc gateway ABI bindings, a change to the check-agent JSON contract, new stub selectors and a vote-submit simulation decode. The write fails safe meanwhile. Revisit before the swarm preflight guard is relied on. |
| SR-1015-15 | SR-1015 | Medium | fixed | rmpc | QA security round 3 (`qa/test-merge-v1`, uncommitted) | rmpc router deposits sent no per-leg floors. Fix: rmpc derives per-leg floors from router.previewDeposit and refuses a weighted unavailable leg unless --allow-unavailable-legs is passed. Compile-checked only; its tests have not run (Phase Q). Residual: Derived floors change the on-chain paymentId, so a retry after a lost local replay cache can land twice. The fork test deposit_router_default_gas_clears_gateway_floor has not run. |
| SR-1015-16 | SR-1015 | Medium | fixed | rmpc | QA security round 1 (`qa/test-merge-v1`, uncommitted) | rmpc withdraw skipped the router implementation check. Fix: rmpc withdraw now verifies the router implementation against proxy_implementation_hashes before it signs withdrawFromRouter, and refuses with ErrImplementationNotApproved. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-17 | SR-1015 | Low | fixed | rmpc | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Committee identity written with umask permissions. Fix: New write_new_owner_only: create_new, mode 0600, set_permissions 0600 before writing, then sync_all. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-18 | SR-1015 | Low | fixed | rmpc | QA security round 3 (`qa/test-merge-v1`, uncommitted) | rmpc did not name LegSkippedWithFloor. Fix: The rmpc refusal_from_revert table maps LegSkippedWithFloor and NoFundedLeg to ErrLegUnavailable, so rmpc refuses before it signs. Compile-checked only; its tests have not run (Phase Q). Residual: The dapp has no revert-name table, so it still shows LegSkippedWithFloor unnamed. |
| SR-1015-19 | SR-1015 | Low | fixed | PortfolioRouter, BasketVault | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Router reverted when a basket leg failed ORA-4. Fix: BasketVault.previewDeposit now runs _checkMarket(false), so the router's quote pass drops the leg and renormalises. Compile-checked only; its tests have not run (Phase Q). Residual: The basket DepositBelowSlippageFloor case can still revert a routed deposit. It is documented in the router NatSpec. |
| SR-1015-20 | SR-1015 | Low | fixed | PortfolioRouter | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Router skipped a leg that carried a non-zero floor. Fix: The router reverts LegSkippedWithFloor when a skipped leg carries a non-zero floor. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-21 | SR-1015 | Medium | fixed | RobotMoneyVault, RobotMoneyVaultOps | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Illiquid adapter exclusion needed the 48 h timelock. Fix: A new EMERGENCY_ROLE lever, emergencyExcludeAdapter(index), opens the exclusion record in one call; only ADMIN can restore the adapter. Compile-checked only; its tests have not run (Phase Q). Residual: The fix gives the EMERGENCY hot key a new exclude-only lever. Issue 1705 (Q2/C6) still owns the decision on EMERGENCY authority. |
| SR-1015-22 | SR-1015 | Medium | fixed | RobotMoneyVault, RobotMoneyVaultOps | QA security round 1 (`qa/test-merge-v1`, uncommitted) | EMERGENCY force-remove of a healthy adapter repriced exits (SR-1012-5). Fix: A funded entry (or one whose totalAssets reverts) with no record gets one at force-remove with a totalSupply snapshot, and the vault sets _exclusionSnapshots. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-23 | SR-1015 | Low | fixed | RouterGovernance | QA security round 1 (`qa/test-merge-v1`, uncommitted) | RouterGovernance claimed a released receipt is always applied. Fix: The NatSpec and governance-decisions.md now say a receipt released by the standalone row carries no weights and can never be applied, and a governance-docs rule bans the old claim. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-24 | SR-1015 | Medium | fixed | AaveV3Adapter, CompoundV3Adapter, RobotMoneyVaultOps, RobotMoneyVault | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Paused lending venue no longer stopped rmUSDC deposits. Fix: Aave and Compound adapters expose venueWithdrawable(), the vault closes deposits while a venue blocks withdrawals, and the adapters revert a supply in that state instead of refunding it. Compile-checked only; its tests have not run (Phase Q). Residual: No watchdog alert exists for DeployRefused or UnroutedDeposit. docs/technical/unified-vault-spec.md still says UnroutedDeposit is monitored. The fork test that pauses the real Aave reserve has not run. |
| SR-1015-25 | SR-1015 | Low | fixed | RobotMoneyVaultOps, AaveV3Adapter, MorphoAdapter, CompoundV3Adapter, RobotMoneyVault | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Lending venue refusing a supply reverted every deposit. Fix: Lending adapters hand a refused supply back to the vault and emit DeployRefused, and routing counts only what the adapter kept. Compile-checked only; its tests have not run (Phase Q). Residual: Deployed deploy-2 adapters lack the refund until they are redeployed. Deposit gas after the extra balance reads was not re-measured. |
| SR-1015-26 | SR-1015 | Medium | fixed | RobotMoneyVaultOps, RobotMoneyVault | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Force-removed excluded adapter re-add sent its balance to NAV. Fix: forceRemoveAdapter now closes a record (ForceRemoved) only when the adapter reads an empty balance. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-27 | SR-1015 | Low | fixed | RobotMoneyVaultOps, RobotMoneyVault, ExclusionLedger | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Force-removed adapter record could only recover all at once. Fix: A new EMERGENCY_ROLE lever, recoverRemovedAdapter(index, amount), drains a force-removed adapter in tranches into its open exclusion record. Compile-checked only; its tests have not run (Phase Q). Residual: The new recoverRemovedAdapter lever is EMERGENCY_ROLE. Issue 1705 owns the authority decision. The illiquid-adapter runbook does not name the lever yet. |
| SR-1015-28 | SR-1015 | Low | fixed | RobotMoneyVaultOps | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Morpho exposure cap turned into a deposit kill switch. Fix: Routing caps each adapter's allocation at its maxExposure headroom, so the excess stays idle instead of reverting the deposit. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-29 | SR-1015 | Info | fixed | watchdog-liveness.md | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Watchdog runbook misdescribed the pause re-send. Fix: The runbook now says a retry re-sends the pause unless depositsPaused() reads true, and an unpause during a held cursor is undone on the next poll until the alert is delivered. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-30 | SR-1015 | Medium | fixed | publish-contracts build-provenance.ts | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Build proof bound HEAD but not the ignored out/ artifacts. Fix: On 8453 proveBuild now requires DIR to be exactly <checkout>/out on both the release-gate and deploy-checkout paths. Compile-checked only; its tests have not run (Phase Q). Residual: A real 8453 upgrade needs out/ rebuilt at the release sha. Operators whose origin still names robotmoney-monorepo are refused until it names robotmoney-core. |
| SR-1015-31 | SR-1015 | Low | fixed | publish-contracts cli.ts | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Owner-signer pre-check counted specs only. Fix: The pre-check reads each spec's claimed owner and refuses a duplicate spec, a duplicate owner or a claim outside SAFE_OWNERS before stage 1. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-32 | SR-1015 | Medium | fixed | publish-contracts evidence-check.ts | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Evidence secret scan missed prefixed secret names. Fix: The secret pattern now matches prefixed *_PASSWORD, *_PASSPHRASE, *_API_KEY, *_SECRET and similar names. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-33 | SR-1015 | Medium | fixed | publish-contracts govern.ts | QA security round 1 (`qa/test-merge-v1`, uncommitted) | govern resume on a fresh manifest dropped the pause interlock. Fix: runStages refuses RESUME when every selected stage is verify or govern and no run manifest exists, and govern also when the timelock stage is not done. Compile-checked only; its tests have not run (Phase Q). Residual: --evidence is still optional on 8453. |
| SR-1015-34 | SR-1015 | Medium | accepted-with-rationale | publish-contracts govern.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: upgrade-proxy trusted any build directory and skipped the layout compare. Fix: A build= directory must be a git checkout whose HEAD is recorded as build_sha, and the upgrade row compares the live layout with the build snapshot under append-only rules. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-35 | SR-1015 | Medium | accepted-with-rationale | publish-contracts govern.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: No release gate covered upgrade and freeze builds. Fix: An explicit build= is proven against the release gate before the Safe is read, and verify and evidence-check refuse an upgrade or freeze without a matching build_sha. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-36 | SR-1015 | Low | accepted-with-rationale | publish-contracts govern.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Retired rmPROTO proxy missed freeze-proxy all. Fix: retiredProxiesOf names each deployed or governed redeploy's old vault <vault>.retired-<n>. Compile-checked only; its tests have not run (Phase Q). Residual: The eight per-proxy verify labels for a retired vault proxy were not added (tooling lane, round 1). |
| SR-1015-37 | SR-1015 | Medium | accepted-with-rationale | publish-contracts layout-compare.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 2 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Upgrade-time layout compare had no enum rule. Fix: LayoutSnapshot gains an enums map, and asLayoutSnapshot validates it. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-38 | SR-1015 | Low | fixed | publish-contracts release-gate.ts | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Build gate ran the gated checkout's own CI check. Fix: ReleaseGateInput gains ciDir: check-sha-green.ts and its required-checks.json now run from ciDir. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-39 | SR-1015 | Low | fixed | publish-contracts release-gate.ts | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Release gate asked check-sha-green about the caller repository. Fix: The gate always asks check-sha-green about robotmoney/robotmoney-core, never the caller's GITHUB_REPOSITORY. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-40 | SR-1015 | Medium | fixed | publish-contracts release-tag.ts | QA security round 3 (`qa/test-merge-v1`, uncommitted) | refs/replace ref passed the 8453 release-tag gate. Fix: Release-tag reads run git with --no-replace-objects and a clean environment, and the remote check peels the tag on the canonical GitHub repository from a neutral directory. Compile-checked only; its tests have not run (Phase Q). Residual: The tag gate now reaches GitHub over https from a neutral directory, so an ssh-only network fails closed. Evidence-check and verify do not re-prove build_tag through the GitHub API. |
| SR-1015-41 | SR-1015 | Low | accepted-with-rationale | publish-contracts runner.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Proxy read-back error left no proxy_gate record. Fix: recordProxyGate records proxy_gate {ok:false, read_error:true} on a throw and exits VERIFY. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-42 | SR-1015 | Low | fixed | publish-contracts runner.ts | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Refused safe-stage confirm broke --resume. Fix: confirmStage now runs before the predicted address is saved, as E2 did for the redeploy. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-43 | SR-1015 | Low | accepted-with-rationale | publish-contracts upgrade-rows.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: upgrade-proxy rounds had no round number. Fix: A completed (executed or skipped) record is archived under <key>:round-n and round n+1 opens when the live implementation slot differs from the target. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-44 | SR-1015 | Low | accepted-with-rationale | publish-contracts verify-stage.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 2 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Upgrade and freeze history keyed by proxy name. Fix: upgradesOf, upgradeLayoutsOf and freezesOf take an optional addressOf (currentProxyAddresses reads each table proxy's stage manifest). Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-45 | SR-1015 | Low | accepted-with-rationale | publish-contracts index.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 3 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Verify with a moved build dir auto-paused all vaults. Fix: Verify refuses before the verifier runs, so nothing auto-pauses, when an upgrade round's build directory is missing, relative or not at build_sha; build directories are recorded as absolute paths. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-46 | SR-1015 | Medium | accepted-with-rationale | CI storage_layout_gate.py | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Layout gate recorded enums by type label only. Fix: normalize() now records an 'enums' map (label -> members in order) for every enum type the storageLayout reaches. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-47 | SR-1015 | High | accepted-with-rationale | CI storage_layout_gate.py | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 3 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Committed layout snapshot never proven equal to the code. Fix: The same-tree check fails any difference between the committed snapshot and the code's layout, and both layout gates refuse a snapshot that reaches a struct or enum it does not record. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-48 | SR-1015 | Medium | accepted-with-rationale | CI storage_layout_gate.py | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 1 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Layout gate compared against a snapshot the change rewrites. Fix: New --base <ref> mode: compare(snapshot at ref via git show, committed snapshot) under the storage rules (variables, gaps, structs, enums, GovernedUpgrade). Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-49 | SR-1015 | High | fixed | install-rmpc.sh | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Any writer could mint the rmpc attestation. Fix: Installer: --source-ref refs/tags/$TAG plus --format json --jq counting verified attestations whose certificate buildTrigger is push; anything but a positive count is exit 6. Compile-checked only; its tests have not run (Phase Q). Residual: Owner action: turn on GitHub immutable releases. rmpc-v0.3.4 was dispatched from dev, so the new installer refuses it until an admin pushes the next rmpc-v tag. |
| SR-1015-50 | SR-1015 | Low | accepted-with-rationale | stage mainnet-dapp.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 2 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: 8453 dapp builder pinned only deploy-time implementations. Fix: The 8453 dapp builder takes --upgrade-evidence and pins the implementation of each executed upgrade round. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-51 | SR-1015 | Medium | fixed | stage mainnet-dapp.ts | QA security round 1 (`qa/test-merge-v1`, uncommitted) | IC policy proxy not watched by the 8453 indexer config. Fix: readMainnetManifests requires addresses.ic_policy and the env sets INDEXER_INVESTMENT_COMMITTEE. Compile-checked only; its tests have not run (Phase Q). Residual: No indexer startup warning or refusal exists when a proxied role address is unset. The stage stack half was fixed in round 2. |
| SR-1015-52 | SR-1015 | Low | accepted-with-rationale | stage mainnet-dapp.ts | superseded by dev's #1832 design (merge 2026-10-15); was QA security round 3 (`qa/test-merge-v1`, uncommitted) | Superseded: QA's upgrade implementation this row concerned was dropped at the merge, and dev's governed-UUPS design (ADR-0014, `GovernedUUPS`) replaces it. Original finding and fix: Implementation pins never retired after an upgrade. Fix: The 8453 dapp build pins only the latest executed implementation of each proxy, so a superseded implementation is no longer accepted. Compile-checked only; its tests have not run (Phase Q). Residual: The dapp-lane half is not done: the rmpc export still writes one flat pin list instead of filtering by each address's live implementation. |
| SR-1015-53 | SR-1015 | Low | fixed | explorer-indexer | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Snapshot pass skipped a same-block exiter. Fix: exclusion_snapshot_candidates now takes the UNION of two sets: owners whose latest row strictly below opened_block holds shares, and every owner with a row at opened_block. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-54 | SR-1015 | Info | fixed | explorer-indexer | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Snapshot filter skipped saturated-zero holders. Fix: The route doc, the db.rs doc and explorer-api.md now state the candidate rule; the filter is unchanged. Compile-checked only; its tests have not run (Phase Q). Residual: Fixed by documenting the rule, not by changing the filter. ExclusionLedger.claimable stays the authority. |
| SR-1015-55 | SR-1015 | Medium | fixed | explorer-indexer | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Indexer derived the exclusion ledger address wrongly. Fix: The indexer reads each vault's exclusionLedger() and stores the answer, and the watched set, the refetch and the emitter gate use that stored mapping. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-56 | SR-1015 | Low | fixed | explorer-indexer | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Indexer cached the exclusion ledger across upgrades. Fix: The indexer re-reads exclusionLedger() after a vault's Upgraded event, keeps every ledger a vault ever named, and refetches the new ledger's logs. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-57 | SR-1015 | Low | fixed | explorer-indexer | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Ledger reads at the safe head missed older ledgers. Fix: A vault's first read is now made at the tick's from_block, or at the registration block for a newly discovered vault. Compile-checked only; its tests have not run (Phase Q). Residual: A full rebuild needs an RPC that serves old state. A pruned node falls back to the newest ledger only. |
| SR-1015-58 | SR-1015 | Low | fixed | explorer-indexer | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Ledger move by a later reinitializer went unseen. Fix: An Initialized(uint64) log from a ledger vault now triggers a ledger re-read, like Upgraded. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-59 | SR-1015 | Low | fixed | explorer-indexer | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Exclusion opening read every historic depositor in the tick. Fix: Snapshot balances are read by a budgeted background pass that resumes across ticks and skips owners with no shares. Compile-checked only; its tests have not run (Phase Q). Residual: Multicall3 batching of snapshot reads was not added. |
| SR-1015-60 | SR-1015 | Low | fixed | explorer-indexer | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Inline receipt fetches had no tick budget. Fix: Inline receipt fetches share a 30 s per-tick budget, and DNS resolution now sits inside the fetch timeout. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-61 | SR-1015 | Low | fixed | explorer-indexer | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Vote memo fetches ran inline with no budget. Fix: The VoteSubmitted branch now shares INLINE_FETCH_TIME_BUDGET with receipts. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-62 | SR-1015 | Low | fixed | explorer-indexer | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Receipt and memo fetches had no host or size limit. Fix: Fetches allow only http and https, refuse link-local, metadata and multicast addresses after DNS, stream bodies under a 1 MiB cap and run under a sweep time budget. Compile-checked only; its tests have not run (Phase Q). Residual: Loopback and private address ranges stay allowed so devnets work. The inline-in-tick part was finished in rounds 2 and 3. |
| SR-1015-63 | SR-1015 | Low | fixed | explorer-indexer | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Same-block share changes lost in wallet_positions. Fix: The wallet_positions table records the last applied log index, so a second change in the same block updates the row and a replay is a no-op. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-64 | SR-1015 | High | fixed | watchdog | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Per-hour mint query grew quadratically with history. Fix: The netting query joins pre-aggregated legs cut to the evaluated window, and the watchdog reports stale when its cursor lags the indexed head beyond a budget. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-65 | SR-1015 | Low | fixed | watchdog | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Direct router deposit counted twice in mint volume. Fix: The direct-deposit source in all four mint queries (global and per-vault, per-block and per-hour) now nets out router legs per (tx, vault): GREATEST(SUM(vte.assets) - SUM(legs.amount), 0), from one shared SQL constant. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-66 | SR-1015 | Medium | fixed | watchdog | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Batched gateway deposit hid a direct vault mint. Fix: Gateway deposits are netted per transaction and vault, so a direct deposit batched with a gateway deposit is counted. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-67 | SR-1015 | Medium | fixed | watchdog | QA security round 3 (`qa/test-merge-v1`, uncommitted) | Per-hour volume window had no upper bound in catch-up. Fix: All four per-hour functions now take the evaluated block number. Compile-checked only; its tests have not run (Phase Q). |
| SR-1015-68 | SR-1015 | Medium | fixed | watchdog | QA security round 1 (`qa/test-merge-v1`, uncommitted) | Held watchdog cursor starved the stuck-pause replacement. Fix: On a retry of a held block the watchdog re-sends the pause unless gateway.depositsPaused() reads true. Compile-checked only; its tests have not run (Phase Q). Residual: An admin unpause while the alert webhook still refuses is undone on the next poll (documented in round 3). |
| SR-1015-69 | SR-1015 | Low | fixed | smoke-test stage env | QA security round 2 (`qa/test-merge-v1`, uncommitted) | Stage stack never watched the IC policy proxy. Fix: The stage stack's dapp compose env now sets the IC policy, timelock and Safe addresses for the indexer. Compile-checked only; its tests have not run (Phase Q). |

### SS-1019 — System split review (2026-10-19, 11 findings)

Internal review of the code that couples the vaults system to the rmpc gateway system, against the owner decision of 2026-10-19
(`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-system-split.md`). Checked at release v0.5.0 (core `57fbe618`) and
`dev` at `e362df0c`. Row `SS-1019-N` is the review's finding heading `### N.`. The second correctness follow-up at `48923e37` adds finding 11, the dapp's shared gateway verification dependency. It is source-traced; the targeted dapp test could not run because Vitest is not installed. Findings remain open; findings 1 to 5 have superseded remediation directions as explained below.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SS-1019-1 | SS-1019 | Medium | accepted-with-rationale | ConsensusRecommendationReceipt | — | Receipt contract accepts writes only from the gateway (SYS-1). Open: operators record through the gateway until the code changes. |
| SS-1019-2 | SS-1019 | Medium | accepted-with-rationale | InvestmentCommitteePolicy | — | IC policy takes the gateway and accepts votes only from it (SYS-1). Open: land SS-1019-3 first. |
| SS-1019-3 | SS-1019 | Medium | accepted-with-rationale | InvestmentCommitteePolicy, RobotMoneyGateway | — | Only the gateway binds a vote to its caller (SYS-2). No effect while onlyGateway stands. Open: must land before SS-1019-2 is fixed. |
| SS-1019-4 | SS-1019 | Low | accepted-with-rationale | RobotMoneyGateway, DeployInvestmentCommitteePolicy | — | Committee writes route through gateway entrypoints, and the gateway keeps ADMIN_ROLE on the IC policy. Open. |
| SS-1019-5 | SS-1019 | Low | accepted-with-rationale | RobotMoneyGateway, publish-contracts govern | — | Committee members and the submitter need gateway AGENT_ROLE and a gateway policy. Open: follows SS-1019-1, 2 and 4. |
| SS-1019-6 | SS-1019 | Info | accepted-with-rationale | contracts/gateway, RouterGovernance | — | Committee contracts live under contracts/gateway/. Open. |
| SS-1019-7 | SS-1019 | Low | accepted-with-rationale | publish-contracts stage table, DeployTimelock | — | One deploy run, handover and verify cover both systems. Open. |
| SS-1019-8 | SS-1019 | Low | accepted-with-rationale | services/explorer-indexer | — | Indexer requires a gateway address. Open. |
| SS-1019-9 | SS-1019 | Low | accepted-with-rationale | testing/smoke-test, suite 28 | — | Test stacks run both systems together. Open. |
| SS-1019-10 | SS-1019 | Info | accepted-with-rationale | InvariantRegistry | — | SYS-1 has no registry entry or test. SYS-2 is retired (2026-10-19), so only SYS-1 needs an entry. Open. |
| SS-1019-11 | SS-1019 | Medium | accepted-with-rationale | clients/dapp AdminFlow, GatewayWriteCheck, useGuardedWriteContract, SafeProposalPanel | — | Shared guard re-verifies the gateway for unrelated human vault actions when cached verification is verified; Safe and timelock targets also require gateway verification. A changed gateway or failed gateway read can block vault actions. Verify each action's own system/targets and cover gateway-free vault and governance flows. Open. |

Rows SS-1019-1 to SS-1019-5 are superseded by the IC policy removal design (IC-1019 below). Their dispositions stay as recorded. The review's committee-write pin question is superseded too: the target removes rmpc committee and receipt writes rather than moving them to direct calls.

### IC-1019 — IC policy removal review (2026-10-19, 15 findings)

Internal review of the code that still carries the on-chain Investment Committee, against the owner decision of 2026-10-19 that
`InvestmentCommitteePolicy` is deleted and the receipt is the only rebalancing input
(`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md`). Checked at release v0.5.0 (core `57fbe618`)
and `dev` at `e362df0c`. Row `IC-1019-N` is the review's finding heading `### N.`. Finding 15 was added 2026-10-20. The correctness follow-up at `48923e37` confirms finding 14 is resolved in this checkout (14 validator tests pass). Its disposition remains open pending verification that the fix landed on `dev`; the other findings remain open.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| IC-1019-1 | IC-1019 | Medium | accepted-with-rationale | InvestmentCommitteePolicy | — | IC policy still exists and is deployed; its tilts feed nothing. Open. |
| IC-1019-2 | IC-1019 | Medium | accepted-with-rationale | ConsensusRecommendationReceipt | — | Receipt authorizes submitters through COMMITTEE_AGENT_ROLE on the IC policy, not its own role. Open. |
| IC-1019-3 | IC-1019 | Medium | accepted-with-rationale | ConsensusRecommendationReceipt | — | Receipt is gateway-only and takes the gateway and IC policy at setup. Open. |
| IC-1019-4 | IC-1019 | Low | accepted-with-rationale | RobotMoneyGateway | — | Gateway still routes committee and receipt writes. Open. |
| IC-1019-5 | IC-1019 | Low | accepted-with-rationale | DeployInvestmentCommitteePolicy, stage table | — | ic-policy stage deploys the IC policy with the receipt. Open. |
| IC-1019-6 | IC-1019 | Low | accepted-with-rationale | DeployTimelock | — | Timelock handover requires IC_POLICY_ADDRESS. Open. |
| IC-1019-7 | IC-1019 | Low | accepted-with-rationale | publish-contracts govern, record-receipt | — | Govern rows route the submitter through the gateway. Open. |
| IC-1019-8 | IC-1019 | Low | accepted-with-rationale | rmpc | — | rmpc keeps committee writes; receipt submit goes to the gateway. Open. |
| IC-1019-9 | IC-1019 | Low | accepted-with-rationale | services/explorer-indexer, clients/explorer-api | — | Indexer and API serve committee and regime data. Open. |
| IC-1019-10 | IC-1019 | Info | accepted-with-rationale | clients/dapp | — | Dapp ships committee and regime-feed components. Open. |
| IC-1019-11 | IC-1019 | Info | accepted-with-rationale | plugins/robotmoney-swarm | — | Swarm plugin forms and submits tilts. Open. Cross-repo action before the plugin is deleted: robotmoney-frontend ships the swarm skill URL and its check-skill-url-reachability script monitors it; the frontend team retires that URL first, or the deletion breaks their check. |
| IC-1019-12 | IC-1019 | Info | accepted-with-rationale | contracts/test, CI | — | Tests, the vote schema check and CI floors still cover the IC policy. Open. |
| IC-1019-13 | IC-1019 | Low | accepted-with-rationale | docs/runbooks/contract-qa/template.yaml | — | Rehearsal runbook still runs the committee steps; changes with the tooling. Open. |
| IC-1019-14 | IC-1019 | Low | accepted-with-rationale | scripts/runbook/validate-contract-qa.ts | — | Real blocker at the original baseline; resolved in checkout 48923e37, where finished releases pin templateSha and are checked against the template at that commit. All 14 validator tests pass, including template evolution; v0.4.0 and v0.5.0 pin e362df0c. Merge status of PR 1887 was not verified; open pending verified landing on dev under the ledger rules. |
| IC-1019-15 | IC-1019 | Info | accepted-with-rationale | plugins/robotmoney-analyst, publish-contracts evidence-check, suites 07/08/13/16, explorer-indexer, smoke-test | — | Surfaces the other findings do not list: the analyst skill text, the register-committee evidence shape, the ABI drift pins, the committee CI steps and floors, the indexer IC input, the public icPolicy/consensusReceipt getters, the IC_POLICY_ADDRESS wiring. Open. |

### RS-1019 — rmpc scope review (2026-10-19, 18 findings)

Internal review of the code that still gives rmpc and the gateway jobs beyond an agent vault deposit, against the owner rule of
2026-10-19 that rmpc is an end-user signer whose one on-chain write is a vault deposit through the gateway
(`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-rmpc-scope.md`). Checked at release v0.5.0 (core `57fbe618`) and
`dev` at `e362df0c`. Row `RS-1019-N` is the review's finding heading `### N.`. Findings 10 to 15 were added 2026-10-20 from the owner decisions of that day. A correctness follow-up at `48923e37` extends findings 5, 12 and 15, qualifies finding 14, and adds findings 16 and 17. Three targeted gateway tests and all 18 receipt tests pass, confirming the old behavior; findings 16 and 17 are source-traced. A second source check extends findings 12 and 15 with dapp/headless ordering and empty destination policies, clarifies finding 13's event preservation, and adds finding 18. Canonical credential, architecture, explorer and setup documentation is reconciled to those requirements; that does not fix the code findings. Every finding remains open.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| RS-1019-1 | RS-1019 | Medium | fixed | RobotMoneyGateway | #1895 (core 1889) | Gateway withdraw and withdrawFromRouter removed. Fixed by issue 1889. |
| RS-1019-2 | RS-1019 | Low | fixed | RobotMoneyGateway | #1895 (core 1889) | Gateway router deposit branch removed. Fixed by issue 1889. |
| RS-1019-3 | RS-1019 | Medium | fixed | rmpc | #1895 (core 1889) | rmpc withdraw and withdraw-router removed. Fixed by issue 1889. |
| RS-1019-4 | RS-1019 | Low | fixed | rmpc | #1895 (core 1889) | rmpc deposit router destination removed. Fixed by issue 1889. |
| RS-1019-5 | RS-1019 | Low | accepted-with-rationale | rmpc, scripts/fusion, publish-contracts cli and record-receipt | — | rmpc receipt submit still records receipts on-chain and the fusion worker uses it. Independent CLI and recordReceipt guards refuse Base production; elsewhere Safe mode is optional and a dedicated EOA can submit. Remove both refusals and require a submitter Safe on every chain. Open. |
| RS-1019-6 | RS-1019 | Low | accepted-with-rationale | clients/dapp configExport and preview | — | Export comments still teach withdrawals; agent-policy preview descriptions still advertise withdrawal/router permissions and the admin authorizeAgent preview remains. Retain zero-valued retired fields in the policy ABI tuple and keep human vault/router actions, while fixing their shared gateway verification dependency under SS-1019-11. Open. |
| RS-1019-7 | RS-1019 | Info | accepted-with-rationale | services/explorer-indexer | — | Indexer still decodes agent withdrawals. Open. |
| RS-1019-8 | RS-1019 | Low | accepted-with-rationale | plugins/robotmoney-user, plugins/robotmoney-cli | — | Plugins still teach withdrawals, router deposits and receipt submit. Open. |
| RS-1019-9 | RS-1019 | Info | accepted-with-rationale | contracts/test, InvariantRegistry, suite 07 | — | Tests, GW-5 in the registry and suite 07 still cover the deprecated paths. Open. |
| RS-1019-10 | RS-1019 | Medium | accepted-with-rationale | RobotMoneyGateway, clients/dapp | — | authorizeAgent and an ADMIN_ROLE grantRole(AGENT_ROLE) register an agent without consent; the same role admin lets an admin revokeRole(AGENT_ROLE). Open. |
| RS-1019-11 | RS-1019 | Medium | accepted-with-rationale | RobotMoneyGateway, DeployTimelock, publish-contracts committee-register | — | ADMIN_ROLE may name any share receiver; transferAgentOwnership hands agents to admins. Open. |
| RS-1019-12 | RS-1019 | Medium | accepted-with-rationale | RobotMoneyGateway, dapp Authorize/onboarding, suite-11b headless setup | — | No self-revoke, expiry does not free an address on reveal, the old owner can renew an already-expired registration through setPolicy without fresh consent, and the reveal consent check has no expiry. Revoke retains the rolling window. Dapp/headless setup commits the owner before requesting agent consent, contrary to the required sequence. Freeze exact reveal inputs and confirm agent consent before owner commit, then reveal within both expiries. Open. |
| RS-1019-13 | RS-1019 | Info | accepted-with-rationale | publish-contracts ops and verify, suites 05/07, clients/dapp commitReveal | — | Surfaces the other findings do not list: derive-agents, the agent manifest fields verify requires, AGENT_ADDRESSES, CI floors and the authorizeAgent comment. Retire deployer-agent derivation and the target ownership-transfer event; preserve AgentAuthorized for policy/indexing and handover checks, and retain historical transfer-event interpretation. Open. |
| RS-1019-14 | RS-1019 | Low | accepted-with-rationale | DeployRouterGovernance, RouterGovernance, ConsensusRecommendationReceipt | — | RouterGovernance holds the receipt's ADMIN_ROLE instead of a narrow release role. Today's receipt has no RECEIPT_SUBMITTER_ROLE and today's governance exposes no submitter-grant or arbitrary-call path; broader submitter authority is a migration hazard once that role is added, not a demonstrated current grant capability. Open. |
| RS-1019-15 | RS-1019 | Low | accepted-with-rationale | RobotMoneyGateway, rmpc deposit preflight, dapp authorization/onboarding/rotation | — | Gateway pins one vault and the router and an empty policy list opens both. The target checks a non-empty owner-selected list without an on-chain registry check. rmpc preflight requires gateway.vault() to match its configured vault; update it to check the actual requested destination. Dapp builders hardcode empty lists: collect explicit destinations before consent and preserve them through authorization, policy changes and export. Open. |
| RS-1019-16 | RS-1019 | Medium | accepted-with-rationale | RobotMoneyGateway deposit and depositTo | — | Legacy deposit calls the pinned vault without checking allowedDestinations; depositTo checks the list. An agent whose policy excludes the pinned vault can still use deposit. Every surviving deposit entrypoint must enforce membership. Open. |
| RS-1019-17 | RS-1019 | Medium | accepted-with-rationale | publish-contracts cli and assertRecordInputs | — | Payload bytes are optional on record-receipt, so syntax-only inputs can reach signing without the digest and receipt-id comparisons architecture section 7.5 requires. Require supported payload bytes and both comparisons before signer construction; preserve the preceding rmpc analyst-signature verification step for those same bytes. Open. |
| RS-1019-18 | RS-1019 | Low | accepted-with-rationale | explorer-indexer agent_policies, explorer-api get_account_policies | — | Account-policy projection selects latest state per chain and agent across registrations before filtering owner. Re-registering an address collapses earlier registrations, despite canon requiring identity by address and registration. Preserve event rows, derive deterministic registration boundaries and update schema/API/history together, including replay and same-block ordering. Open. |

### RP-1021 — RM parked out of rmAGENT (2026-10-21, 3 findings)

Internal review of the owner decision to park RM out of rmAGENT until its market is deep enough, with the measured evidence and the reactivation path (`docs/code-review/20261021-code-review-internal-claude-rm-parked-from-rmagent.md`, [ADR-0015](adr/ADR-0015-rm-parked-from-rmagent-until-market-depth.md)). Row `RP-1021-N` is the review's finding heading `### N.`.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| RP-1021-1 | RP-1021 | Medium | accepted-with-rationale | BasketVault, DeployAgentTokenVault, config-check | — | The pool-depth guard is raw liquidity L, a different dollar depth at every price (L 1e15 is about 1.7 USDC at the measured RM price). The guard stays at 1e15. Reactivation is decided by dollar criteria in the shortlist config and ADR-0015. |
| RP-1021-2 | RP-1021 | Medium | accepted-with-rationale | AgentTokenVault, config/agent-token-shortlist.json | — | rmAGENT launches with BNKR as a test asset on a thin pool (about 706 USD virtual, ADR-0016) while RM is parked by the owner (2026-10-21). Open until the RM criteria hold, or a deeper venue is decided, and a timelock addAsset lands. |
| RP-1021-3 | RP-1021 | Low | accepted-with-rationale | testing/smoke-test twin_publish, contracts/test fork tests, scripts/ci | — | Tests that need RM and its pool run on a reactivated copy of the config (RM_PARKED), never skipped, no bound lowered, no liquidity seeded. Issue 1900 (seed the Twin pool) is superseded. |

### RB-1022 — Release branch model: tooling and CI gaps (2026-10-22, 9 findings)

Internal review of the gaps between the release branch policy (`docs/operations/contract-release-runbooks.md` sections 2, 3, 4.5, 4.14 and 7) and today's tooling, CI and repository settings (`docs/code-review/20261022-code-review-internal-claude-release-branch-model-gaps.md`). The review also records how `releases-0.5.x` relates to its rc tags and to `dev`. Row `RB-1022-N` is the review's finding heading `### N.`.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| RB-1022-1 | RB-1022 | Medium | accepted-with-rationale | release-tag.ts, release-gate.ts | — | The release gate binds an rc tag to a sha only. It does not check the release branch, the rc name grammar or the QA-passed tree. Open until a tool and the gate enforce them. |
| RB-1022-2 | RB-1022 | Medium | accepted-with-rationale | release-gate.ts, cli.ts (counts-require-origin-dev) | — | The counts-checkout flag proves reachability from origin/dev only, so a counts commit on releases-A.B.x is refused. Open until the flag takes the release line's origin ref. |
| RB-1022-3 | RB-1022 | Medium | accepted-with-rationale | suite-01-02 to suite-28 triggers, check-sha-green, deploy-gate-jobs | — | No workflow runs on qa/** and only six name releases-*, so a squash commit on the release branch lacks the required jobs. Open until the push triggers and the deploy-gate derivation cover both. |
| RB-1022-4 | RB-1022 | Low | accepted-with-rationale | check-core-storage-layout.sh --releases | — | The layout baseline reads every non-rehearsal release/* tag, so an undeployed rc becomes a baseline. Open until it reads the version tags of deployed releases. |
| RB-1022-5 | RB-1022 | Medium | accepted-with-rationale | scripts/release, contract QA runbook runner | — | No tool cuts the rc, checks the squash or keeps the QA journal with the tree hash. Open until a tool in scripts/release does. |
| RB-1022-6 | RB-1022 | Low | accepted-with-rationale | validate-contract-qa.ts, template pin | — | The validator does not bind a target to its ref, and a templateSha on a QA branch commit depends on the branch being kept. Open until the validator checks both. |
| RB-1022-7 | RB-1022 | Low | accepted-with-rationale | branch protection, tag rulesets | — | The never-rewritten, squash-only and tag-immutability rules are conventions because branch protection is a won't-fix. The release/* ruleset is an owner setting still to do. |
| RB-1022-8 | RB-1022 | Low | accepted-with-rationale | validate-contract-qa.ts scopeProblems | — | The scope list is checked for shape, not against the commits between the deployed version and the rc. Open until a scope step compares them. |
| RB-1022-9 | RB-1022 | Low | accepted-with-rationale | fusion-devnet-ci.md, legacy releases-v0.4.0-base branches | — | A doc names a releases-0.4.x branch that is not on origin, and four legacy branches use the old naming. Open until the owner archives or deletes them. |

### RM-1022 — Typed receipt migration for the governed upgrade row (2026-10-22, 3 findings)

Internal review of the typed `--migration` option of `govern --row upgrade-proxy` that lets the live v0.5.0 receipt proxy take `migrateToSubmitterRoles` in the same `upgradeToAndCall` (`docs/code-review/20261022-code-review-internal-claude-receipt-migration-tooling.md`, core issue 1910). Row `RM-1022-N` is the review's finding heading `### N.`.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| RM-1022-1 | RM-1022 | Low | accepted-with-rationale | publish-contracts upgrade-rows, govern | — | The typed migration registry has one entry (receipt-submitter-roles). Another proxy migration is a reviewed code change with tests and a Twin proof, by design: no free hex path exists on 8453. |
| RM-1022-2 | RM-1022 | Low | accepted-with-rationale | publish-contracts govern upgrade-proxy, ConsensusRecommendationReceipt | — | The row does not read the live proxy's initialized version or ADMIN_ROLE holders before it schedules. A proxy already at version 2 reverts atomically at the timelock execute with InvalidInitialization, so no half state exists. The operator reads the live pre-state before the schedule (runbook). |
| RM-1022-3 | RM-1022 | Low | accepted-with-rationale | twin-upgrade-lifecycle, LegacyConsensusRecommendationReceipt, ConsensusReceiptMigration.t.sol | — | The Twin proof uses a source-level copy of the v0.5.0 receipt (same state, write surface and storage layout), not the byte-identical deployed code. Verify compares the live implementation with the DEPLOY_SHA build. |

### RR-1022 — Retire rmAGENT, router uses three vaults (2026-10-22, 7 findings)

Internal review of the rmAGENT retirement (`docs/code-review/20261022-code-review-internal-claude-retire-rmagent.md`, core issue 1912, ADR-0017). Row `RR-1022-N` is the review's finding heading `### N.`.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| RR-1022-1 | RR-1022 | Medium | accepted-with-rationale | retire-vault row, runbook 4.14 | — | The live router still holds four legs until the owner-gated timelock batch runs. Open until the owner schedules it (runbook 4.14). |
| RR-1022-2 | RR-1022 | Low | accepted-with-rationale | AgentTokenVault redeem, ADR-0009 | — | ADR-0009 forbids assisted migration. A holder exits with redeem or redeemInKind. |
| RR-1022-3 | RR-1022 | Low | accepted-with-rationale | recorder-keeper.sh, UniswapV4PriceRecorder | — | redeem reads the V4 recorder while holders remain. The keeper keeps running, or holders use redeemInKind. A v0.6.0 deployment has no recorder. |
| RR-1022-4 | RR-1022 | Low | accepted-with-rationale | apply-receipt, consensus-receipt.bucket-vault-map.json | — | The bucket is the Investment Committee's cross-repository contract. apply-receipt accepts it at 0 bps and refuses any weight. The IC repository decision is the owner's. |
| RR-1022-5 | RR-1022 | Low | accepted-with-rationale | DeployAgentTokenVault.s.sol, DeployUniswapV4PriceRecorder.s.sol, agent-token-shortlist.json | — | No stage reads the parked code. Deleting it is a later decision. |
| RR-1022-6 | RR-1022 | Low | accepted-with-rationale | deploy-3.env, v0.5.0 tag | — | v0.5.0 tooling, frozen counts and QA records stay at the tag. deploy-3.env is the v0.5.0 record. |
| RR-1022-7 | RR-1022 | Low | accepted-with-rationale | contract release runbooks section 3 | — | A v0.6.0 rc loses the agent and recorder counts. They are measured and frozen at the rc as for every release. |

### Gap analysis — process & coverage backlog (20260607-code-review-internal-claude-gap-analysis.md)

> The gap analysis enumerates 50 tracked-as-future-work items (issues #643–#692),
> not contract bugs. SECURITY-003 ("No audit ledger") is resolved by this issue
> (#1010). The remainder are open, each tracked by its GitHub issue.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SECURITY-003 | 20260607-code-review-internal-claude-gap-analysis.md | Medium | fixed | docs/audits.md, SECURITY.md | #1013, #1014 | "No audit ledger" — resolved by creating this `docs/audits.md` and the repo-root `SECURITY.md` (issue #1010) |
| SECURITY-001 | 20260607-code-review-internal-claude-gap-analysis.md | Medium | fixed | SECURITY.md | #1013, #1014 | "No SECURITY.md at repo root" — resolved by creating repo-root `SECURITY.md` (tracking issue #643) |
| GAP-BACKLOG | 20260607-code-review-internal-claude-gap-analysis.md | Critical–Low | accepted-with-rationale | architecture/security-model/CI/dapp/rmpc surfaces | — | The remaining ~48 gap items (#643–#692, e.g. MAINNET-001, WATCHDOG-001, CSP-001, bug-bounty SECURITY-002) are acknowledged future-work, each tracked by its GitHub issue; a coverage backlog, not a per-contract vulnerability. Re-checked 2026-10-15 (SR-1012-9): FORCEREMOVE-001 (loss path untested) is now covered by `RobotMoneyVault.t.sol::test_forceRemoveAdapter_deactivatesAdapterAndEmitsCorrectLoss`, `test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts` and `SecurityReviewRecheckVaultPoc.t.sol::test_O1a_forceRemoveAllFunded_exiterKeepsFullRecoveryClaim`; the loss attribution is fixed as SR-1012-5 (security round 1) |

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
| SR-1012 accepted-open (SR-1012-V4) | accepted-with-rationale | 20261012-security-review.md (adversarial re-check pass with reproductions) + 2026-10-15 source re-check on `qa/test-merge-v1` | Every EMERGENCY lever before the #1705 Q2/C6 decision lands (SR-1012-5 is fixed in security round 1); `UniswapV4PriceRecorder`, `BasketViews.checkSellAnchor` and the recorder ring before the final deployment's price-source decision |
| SR-1015 deferred (SR-1015-14) | accepted-with-rationale | 20261015-review-security-claude.md (seven lens finders, three-skeptic majority per candidate) | rmpc `check-agent` and `vote-submit` before the swarm preflight guard is relied on |
