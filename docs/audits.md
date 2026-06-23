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
  (disposition = field 5, checked-against = field 6) stays valid.

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
> has no remediation. Every `fixed` row carries a PR.

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
-->

Every production contract under `contracts/` (excluding `contracts/test/`,
`contracts/script/`, `contracts/interfaces/`, and the generated
`contracts/doc/` mirror) is mapped to the audit report(s) that covered it.

| Contract | Audit report(s) | Status | Exception (if any) |
|---|---|---|---|
| `RobotMoneyVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | — |
| `RmToken.sol` | VA-0609, HR-0618 | Audited | — |
| `PortfolioRouter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, SR-0612, AZ-0623 | Audited | — |
| `RouterGovernance.sol` | VA-0609, HR-0618, MC-0619, CD-0602, SR-0612, AZ-0623 | Audited | — |
| `VaultRegistry.sol` | VA-0609, HR-0618, MC-0619, CD-0602, SR-0612, AZ-0623 | Audited | — |
| `FeatureFlags.sol` | VA-0609 | Audited | Pre-mainnet re-audit pending under the bucket-B/C economic-audit gate (security-model.md §14) |
| `UniswapV3PoolSlot0Stub.sol` | VA-0609, HR-0618 | Audited | Devnet/demo helper; not router-eligible. Documented exception: fail-closed at the vault, not a production swap surface |
| `gateway/RobotMoneyGateway.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | — |
| `gateway/AccessRoles.sol` | VA-0609, HR-0618, MC-0619, CD-0602 | Audited | — |
| `gateway/MockVault.sol` | VA-0609, HR-0618 | Audited | Test/mock surface (constructor asset-mismatch revert pinned, HR-0618 I-9); not production-reachable |
| `vaults/BasketVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612, AZ-0623 | Audited | Bucket-B/C economic-model audit required before router-eligible production use (security-model.md §14; gap BASKET-001/ECONOMIC-AUDIT-001) |
| `vaults/RwaVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612, AZ-0623 | Audited | Same bucket-B/C economic-audit gate as BasketVault |
| `vaults/AgentTokenVault.sol` | VA-0609, HR-0618 | Audited | Same bucket-B/C economic-audit gate |
| `vaults/ProtocolAssetVault.sol` | VA-0609, HR-0618 | Audited | Same bucket-B/C economic-audit gate |
| `adapters/AaveV3Adapter.sol` | VA-0609, HR-0618, SR-0612 | Audited | — |
| `adapters/CompoundV3Adapter.sol` | VA-0609, HR-0618, FS-0619, SR-0612 | Audited | — |
| `adapters/MorphoAdapter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | — |
| `adapters/AerodromeSwapAdapter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | — |
| `adapters/UniswapV4SwapAdapter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | — |
| `adapters/ChronicleOracleAdapter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | — |
| `lib/TickMath.sol` | HR-0618 | Audited | Externalized library (HR-0618 L3-D1); `pure` math, byte-identical, mis-link operational risk noted |
| `lib/TwapTickMath.sol` | HR-0618 (via BasketVault TWAP path) | Audited | TWAP helper exercised through BasketVault NAV review |
| `lib/AdminFloorAccessControl.sol` | MC-0619 (via F-06 admin-floor remediation) | Audited | Admin-floor mixin introduced by the F-06 remediation |
| `lib/BasketAssetConfigGuard.sol` | HR-0618, MC-0619 (via BasketVault addAsset path) | Audited | Reviewed through BasketVault `addAsset` config-validation findings |
| `lib/BasketViews.sol` | HR-0618 (via BasketVault NAV/preview path) | Audited | View helper exercised through BasketVault preview findings |
| `lib/BpsMath.sol` | VA-0609, HR-0618 (via exit-fee rounding findings) | Audited | Basis-point math exercised through exit-fee rounding findings |
| `lib/ForeignTokenQuarantine.sol` | HR-0618 (via reabsorb/quarantine path) | Audited | Quarantine/reabsorb path reviewed under MC-0619 F-17 / HR-0618 |

> No production contract ships without coverage above. The recorded exceptions
> (FeatureFlags pre-mainnet re-audit, the bucket-B/C basket-vault economic-audit
> gate, and the devnet-only `UniswapV3PoolSlot0Stub` / `MockVault` helpers) are
> the documented, team-approved carve-outs required by §14.

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
findings whose "fix specified" never landed (FS-RTR-1, FS-VLT-10, FS-VLT-19) are
corrected to `accepted-with-rationale` (open); FS-VLT-25 does not reproduce.

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
| FS-RTR-1 | FS-0619 | High→Medium | accepted-with-rationale | PortfolioRouter | — | Pre-existing USDC dust bricks router deposits; CONFIRMED at HEAD — strict `usdc.balanceOf!=0` invariant unchanged, no carve-out landed (availability-only DoS) |
| FS-RTR-2 | FS-0619 | High→Low | fixed | RobotMoneyGateway, PortfolioRouter | #836 | Redeemer allowance-guard not consumed; `UnauthorizedRedeemer` guard mitigates (gateway self-custodies), confused-deputy theoretical |
| FS-RTR-3 | FS-0619 | High→Low/Info | dismissed-with-rationale | PortfolioRouter, RobotMoneyGateway | — | "Arbitrary shareReceiver pull" refuted: plain transferFrom needs victim's own allowance; one of 4 collapsing High findings (listed twice) |
| FS-RTR-4 | FS-0619 | Medium→Low | dismissed-with-rationale | PortfolioRouter | — | Agent authorization needs no agent consent; `_assertRoleSeparation` blocks the AGENT_ROLE escalation |
| FS-RTR-5 | FS-0619 | Medium | accepted-with-rationale | PortfolioRouter | — | Commit/reveal front-run squatter DoS; nuisance, confirmed |
| FS-RTR-6 | FS-0619 | Medium→Low | accepted-with-rationale | RobotMoneyGateway | — | `depositTo` paymentId omits destination + minSharesPerLeg; benign, self-affecting |
| FS-RTR-7 | FS-0619 | Medium | accepted-with-rationale | PortfolioRouter | — | Empty `allowedSourceVaults` not enforced on router withdrawals; hardening |
| FS-RTR-8 | FS-0619 | Medium→Low | accepted-with-rationale | RobotMoneyGateway | — | Router withdrawals can't enforce per-leg min assets; by design (L-8) |
| FS-RTR-9 | FS-0619 | Medium→Low | accepted-with-rationale | PortfolioRouter | — | Router-withdrawal paymentId binds only totalShares; benign |
| FS-RTR-10 | FS-0619 | Medium→Low | accepted-with-rationale | PortfolioRouter | — | Rounding remainder lets tiny split deposits bypass weights; cosmetic |
| FS-VLT-1 | FS-0619 | Medium→Info | accepted-with-rationale | RobotMoneyVault | — | `IUpstreamMonitor` health gate not enforced; by-design stub |
| FS-VLT-2 | FS-0619 | Medium→Info | dismissed-with-rationale | AerodromeSwapAdapter | — | Slipstream slot0 ABI "mismatch" refuted; targets repo's own internally-consistent shim |
| FS-VLT-3 | FS-0619 | Medium | accepted-with-rationale | RwaVault, ChronicleOracleAdapter | — | Chronicle RWA route vs V3-style addAsset checks; latent integration |
| FS-VLT-4 | FS-0619 | Medium→Info | dismissed-with-rationale | CompoundV3Adapter | — | Rewards "not harvested" refuted; they accrue in share price |
| FS-VLT-5 | FS-0619 | Medium | accepted-with-rationale | RobotMoneyVault | — | Deposits mint on max-slippage haircut; by design (H-1) |
| FS-VLT-6 | FS-0619 | Medium→down | dismissed-with-rationale | BasketVault | — | "Greedy deposit reverts" refuted for HEAD (skips + idles); claim on stale `src/` |
| FS-VLT-7 | FS-0619 | Medium | dismissed-with-rationale | RobotMoneyVault | — | "Idle assets excluded from totalAssets" refuted; HEAD includes idle |
| FS-VLT-8 | FS-0619 | Medium→down | accepted-with-rationale | RobotMoneyVault | — | Idle-first withdrawals; matches HEAD, benign |
| FS-VLT-9 | FS-0619 | Medium | accepted-with-rationale | BasketVault | — | Inactive asset entries consume basket capacity; low impact |
| FS-VLT-10 | FS-0619 | Medium | accepted-with-rationale | MorphoAdapter | — | Morpho reports illiquid shares as withdrawable; CONFIRMED at HEAD — `totalAssets()` still `convertToAssets(shares)` with no maxWithdraw cap, no fix landed |
| FS-VLT-11 | FS-0619 | Medium | dismissed-with-rationale | BasketVault, MorphoAdapter | — | Stale duplicate of FS-VLT-10 |
| FS-VLT-12 | FS-0619 | Medium→down | accepted-with-rationale | VaultRegistry, vault | — | Registry Paused doesn't halt direct deposits; router gates by design |
| FS-VLT-13 | FS-0619 | Medium | accepted-with-rationale | RwaVault | — | RWA redemption blocked by price deviation from NAV; by design (ADR-0006) |
| FS-VLT-14 | FS-0619 | Medium→Info | dismissed-with-rationale | RwaVault, ChronicleOracleAdapter | — | RWA freshness `latestTimestamp()` "noncanonical" refuted; own IChronicleOracle |
| FS-VLT-15 | FS-0619 | Medium→down | fixed | RobotMoneyVault | #200 | Receipt-token donation inflation mitigated by 1e18 `_decimalsOffset` (mitigation pre-dates the scan) |
| FS-VLT-16 | FS-0619 | Medium→Info | dismissed-with-rationale | UniswapV4SwapAdapter | — | "Noncanonical router ABI" refuted; own shim |
| FS-VLT-17 | FS-0619 | Medium | accepted-with-rationale | UniswapV4SwapAdapter | — | V4 pricing assumes V3 observe() pool; demo vault, not router-eligible |
| FS-VLT-18 | FS-0619 | Medium | fixed | VaultRegistry, RobotMoneyVault | #959 | Retire left router-eligibility state stale; unified registry-driven `retire()`/`unretire()` on the base vault |
| FS-VLT-19 | FS-0619 | Medium | accepted-with-rationale | VaultRegistry, BasketVault | — | Registry retire() reverts on basket subclasses; CONFIRMED still-latent — `vaults/` subclasses don't inherit `RobotMoneyVault`/`IRetirableVault`, no fix landed |
| FS-VLT-20 | FS-0619 | Medium→down | accepted-with-rationale | BasketVault | — | Withdrawals/rebalance push adapters above caps; by design, re-converges |
| FS-VLT-21 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | `redeem()` return diverges from USDC transferred; confirmed, minor |
| FS-VLT-22 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | Exact-asset withdraw overcharges fee (ceil gross-up); ±1 unit dust |
| FS-VLT-23 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | — | Exit fee rounds to zero on dust chunks; ±1 unit dust |
| FS-VLT-24 | FS-0619 | Medium→down | dismissed-with-rationale | RobotMoneyVault | — | "maxWithdraw unwithdrawable" refuted; L-1 floor fix is a counter-example |
| FS-VLT-25 | FS-0619 | Low→Medium | dismissed-with-rationale | RobotMoneyVault | — | "Emergency-unwind deposit-pause uncleanable" refuted; `emergencyUnwind` sets only `depositsPaused`, already cleared by Pausable-independent `_setDepositsPaused(false)` |
| FS-VLT-26 | FS-0619 | Low | accepted-with-rationale | BasketVault | — | Dust donations block asset removal; confirmed, minor |
| FS-VLT-27 | FS-0619 | Low→Info | accepted-with-rationale | RobotMoneyVault | — | `decimals()=6` vs `_decimalsOffset()=18`; documented |
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
| MC-F-07 | MC-0619 | Medium | fixed | BasketVault, RwaVault | #980 | `shutdownVault` irreversible; ADMIN-gated `restoreVault(newTvlCap)` inverts it (LIFE-4) |
| MC-F-08 | MC-0619 | Medium | fixed | RwaVault | #975 | Stale-override + unwind under one EMERGENCY key; `setEmergencyUnwindStaleOverride` moved to ADMIN_ROLE (ACL-5) |
| MC-F-09 | MC-0619 | Medium | fixed | UniswapV4SwapAdapter, AerodromeSwapAdapter, BasketVault | #975 | TWAP quote pool could mismatch execution pool; `BasketAssetConfigGuard` asserts execution-pool == TWAP-pool in `addAsset` (ORA-3) |
| MC-F-10 | MC-0619 | Medium | fixed | RwaVault, ChronicleOracleAdapter | #978 | No NAV-vs-market deviation guard; timelock-configured deviation threshold reverts over-threshold deposits (ORA-4) |
| MC-F-11 | MC-0619 | Low | fixed | RobotMoneyGateway | #978 | Gateway zeroed router per-leg floor + disabled deadline; `withdrawFromRouter` forwards `minAssetsPerLeg[]` into intent hash (GW-5) |
| MC-F-12 | MC-0619 | Low | accepted-with-rationale | PortfolioRouter | — | Router cap per-tx only, splittable; documented as per-tx sanity bound (fix-or-document accepted, #980 recorded the decision) |
| MC-F-13 | MC-0619 | Low | fixed | PortfolioRouter | #976 | Deposit all-or-revert diverged from preview; `_executeLegs` now skip-and-renormalise (RTR-5) |
| MC-F-14 | MC-0619 | Low | fixed | RobotMoneyVault | #980 | Revoked-but-active adapter still trusted for NAV; `totalAssets`/`_pullProportional` exclude ineligible adapters (ADP-2) |
| MC-F-15 | MC-0619 | Low | fixed | RobotMoneyGateway | #979 | Idempotency hash omitted destination + per-leg shares; `depositTo` paymentId folds them in (GW-2); withdraw side already bound (#980) |
| MC-F-16 | MC-0619 | Info | fixed | RobotMoneyVault, MorphoAdapter, BasketVault | #978 | NAV trusted subcomponent prices/TWAP marks; `_deposit` mints on realized swap proceeds + round-trip pinned (SUP-3/NC-6) |
| MC-F-17 | MC-0619 | Info | fixed | ChronicleOracleAdapter, BasketVault | #979 | Reabsorb reused stale pool; `reabsorbRemovedAsset` wraps TWAP read in quarantine fallback (LIFE-6). Hardcoded-18-dec half accepted as latent (safe while deSPXA=18) |
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
| HR-M-1 | VA-0609/HR-0618 | Medium | fixed | ChronicleOracleAdapter | #836 | Rejects zero/degenerate oracle price; bounds pinned |
| HR-M-2 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyVault | #836 | `withdraw(maxWithdraw)` 4626 violation; fee-enabled conformance suite |
| HR-M-3 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyVault | #836 | `forceRemoveAdapter` now pauses deposits; pinned |
| HR-M-4 | VA-0609/HR-0618 | Medium | fixed | RwaVault, BasketVault | #836 | RWA emergency unwind staleness gate on both paths; pinned |
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
| HR-L-5 | VA-0609/HR-0618 | Low | fixed | AerodromeSwapAdapter, ChronicleOracleAdapter, UniswapV4SwapAdapter | #836 | Caller deadline forwarded; pinned |
| HR-L-6 | VA-0609/HR-0618 | Low | fixed | UniswapV4SwapAdapter | #836 | SafeCast on uint128 truncation; pinned |
| HR-L-7 | VA-0609/HR-0618 | Low | fixed | AerodromeSwapAdapter, ChronicleOracleAdapter | #836 | Unchecked router return-array indexing; structural rewrite (Chronicle secondary site lacks dedicated test) |
| HR-L-8 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter | #920 | `redeemFor` no slippage/deadline; `minAssetsPerLeg` + deadline added (open at HR-0618 HEAD, fixed by #920) |
| HR-L-9 | VA-0609/HR-0618 | Low | accepted-with-rationale | PortfolioRouter | — | `setWeights` accepts duplicate vault entries; admin-gated, accepted |
| HR-L-10 | VA-0609/HR-0618 | Low | fixed | PortfolioRouter, RouterGovernance, VaultRegistry | #920 | Self-administered ADMIN_ROLE no floor; shared `AdminFloorAccessControl` forbids dropping to zero (open at HR-0618 HEAD, fixed by #920) |
| HR-L-11 | VA-0609/HR-0618 | Low | accepted-with-rationale | PortfolioRouter | — | `rescueUsdc` unconditional admin sweep; accepted by design (custody invariant limits blast radius) |
| HR-L-12 | VA-0609/HR-0618 | Low | fixed | RobotMoneyGateway | #836 | `withdrawFromRouter` paymentId OP-prefix added; pinned |
| HR-L-13 | VA-0609/HR-0618 | Low | accepted-with-rationale | RobotMoneyGateway | — | `withdraw` pulls shares from agent not shareReceiver; WONTFIX-by-design, documented + test-covered in #836 |
| HR-L-14 | VA-0609/HR-0618 | Low | fixed | AccessRoles | #836 | Role-separation override honors DEFAULT_ADMIN_ROLE; pinned |
| HR-L-15 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | Removed assets rescuable if tokens reappear; pinned |
| HR-L-16 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | `maxDeposit`/`maxMint` honor caps/shutdown/pause; pinned |
| HR-L-17 | VA-0609/HR-0618 | Low | fixed | BasketVault | #836 | `setMaxSlippageBps(0)` pool-fee floor; pinned |
| HR-I-1 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | — | Adapter array never compacted; bounded by MAX_ADAPTERS active cap |
| HR-I-2 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | — | Exit-fee dust floors to zero; accepted by design |
| HR-I-3 | VA-0609/HR-0618 | Info | accepted-with-rationale | MorphoAdapter | — | `max` sentinel ignored; out-of-trust-model, vault never passes max |
| HR-I-4 | VA-0609/HR-0618 | Info | accepted-with-rationale | RmToken | — | approve race / infinite allowance; devnet token, not mainnet-ready |
| HR-I-5 | VA-0609/HR-0618 | Info | accepted-with-rationale | UniswapV3PoolSlot0Stub | — | No chain-id guard; demo-only, fail-closed at vault |
| HR-I-6 | VA-0609/HR-0618 | Info | accepted-with-rationale | UniswapV4SwapAdapter | — | No fee-on-transfer delta check; admin-curated input, out of trust model |
| HR-I-7 | VA-0609/HR-0618 | Info | accepted-with-rationale | VaultRegistry | — | Stores `asset` without 4626 cross-check; admin-only, router re-derives |
| HR-I-8 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyGateway | — | Unbounded AgentPolicy whitelist arrays; owner-self-DoS, out of trust model |
| HR-I-9 | VA-0609/HR-0618 | Info | fixed | MockVault | #836 | Constructor asset-mismatch revert; pinned, not production-reachable |
| HR-I-10 | VA-0609/HR-0618 | Info | fixed | ChronicleOracleAdapter | #836 | Hardcoded `WAD*1e12` scaling documented + `UnknownPricePair` revert tests |
| HR-L3-D1 | HR-0618 | Low | fixed | BasketVault, lib/TickMath | #920 | Externalized NAV math via deploy-linked library (TickMath externalization #877); #920 adds linked-codehash assertion + totalAssets sanity probe |
| HR-L3-F1 | HR-0618 | Info | accepted-with-rationale | BasketVault | — | Per-leg sell flooring can dip redeem below preview; dust-bounded (<1¢), documented (ADR-0007) |
| HR-L3-F2 | HR-0618 | Info | accepted-with-rationale | RobotMoneyGateway | — | `revokeAgent` leaves rolling-window state uncleared; conservative, self-healing within window |
| HR-L3-D2 | HR-0618 | Info | fixed | script/AdapterBytecodeGuard | #922 | Stale natspec listed Passthrough; purged from natspec + forge-doc mirror, grep-guarded |
| HR-S-1 | HR-0618 | Info | dismissed-with-rationale | Slither (production source) | — | 0 High, 0 true-positive Medium; all hits known-safe patterns, no action |

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
| SR-0612-OPEN | SR-0612 | High–Medium | accepted-with-rationale | RobotMoneyGateway, PortfolioRouter, RobotMoneyVault, BasketVault, RwaVault, RouterGovernance, ChronicleOracleAdapter, AerodromeSwapAdapter | — | 4 High + 19 Medium + 14 Low + 10 Info open on `dev` (or with fixes only on an unmerged remediation branch); each a known, acknowledged risk pending the contract-security-remediation phases (#933/#958/#987) |
| SR-0612-P1 | SR-0612 | Process | accepted-with-rationale | docs/code-review/20260606-code-review-internal-claude.md | — | Audit/remediation drift: DC-0606 claimed fixes (VAULT-002, VAULT-006, ORA-001/AC-005, MEV-001, AC-006, GOV-001/AC-002, VaultRegistry asset check) never landed on `dev`; recorded so this ledger reflects landing status, not claimed status |
| DC-0606-LANDED | DC-0606 | High–Info | fixed | RobotMoneyVault, BasketVault, RobotMoneyGateway, RouterGovernance, ChronicleOracleAdapter, UniswapV4SwapAdapter, explorer-indexer, rmpc, dapp | #836, #933, #958 | ~63 deep-clean findings landed (5 Critical/High + Medium/Low/Info) across the contract-security-remediation phases; excludes the 8 contradicted-by-SR-0612 claims (above) and the 4 deferred items (below) |
| DC-0606-DEFER | DC-0606 | Deferred | accepted-with-rationale | VaultRegistry, RouterGovernance, BasketVault/AgentTokenVault, admin-transfer surface | — | 4 deferred items (RMDA-003 stale cached status, GOV-003 execute() re-validation, VAULT-011 SHORTLIST_ADD_DELAY, AC-008 two-step admin transfer); NatSpec invariant added, full fix needs governance/interface upgrade |

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
| AZ-GW-1 | AZ-0623 | Critical | accepted-with-rationale | RobotMoneyGateway, PortfolioRouter | — | Gateway arbitrary shareReceiver drain: attacker creates permissionless policy with victim as shareReceiver; gateway calls redeemFor using victim's existing gateway approval as the allowance check passes. #751 guards router layer only. Mainnet-blocking. |
| AZ-BSK-1 | AZ-0623 | High | accepted-with-rationale | BasketVault | — | Deposits mint shares against slippage-floor (discounted credit), not realized NAV; when realized NAV > floor, uncredited surplus remains in totalAssets for existing shareholders to extract. No existing fix. |
| AZ-RTR-2 | AZ-0623 | High | accepted-with-rationale | PortfolioRouter | — | Donated USDC DoS: absolute-zero post-deposit invariant + USDC sweep rejection means any external USDC transfer to router permanently blocks all deposits. Distinct from FS-RTR-1 (blacklist/fee-on-transfer). |
| AZ-BSK-2 | AZ-0623 | Medium→High | accepted-with-rationale | BasketVault, PortfolioRouter | — | BasketVault _deposit/_withdraw overrides discard the ERC4626 `shares`/`assets` args and mint/transfer post-swap amounts, but OZ ERC4626 returns the previewed (overstated) value; router slippage check against overstated return. Compounds with AZ-BSK-1. |
| AZ-GW-2 | AZ-0623 | Medium | accepted-with-rationale | RobotMoneyGateway, rmpc (get_agent.rs), dapp (AgentPoliciesPanel.tsx) | — | rmpc get-agent and dapp report allowance(agent, gateway); router withdrawals spend shareReceiver allowances. Operator sees wrong blast radius for router-withdrawal policies. |
| AZ-DAPP-1 | AZ-0623 | Medium | accepted-with-rationale | dapp (OnboardingWizard.tsx, AuthorizeTab.tsx), RobotMoneyGateway | — | Dapp onboarding and authorize tab call admin-only `authorizeAgent`; permissionless commit/reveal path not wired. Normal depositor cannot complete wizard. |
| AZ-RPC-1 | AZ-0623 | Medium | accepted-with-rationale | rmpc (deposit.rs, tx/mod.rs) | — | Deposit receipt timeout unconditionally clears the replay cache entry even though timeout ≠ tx failed; in-flight tx can succeed after entry deleted, allowing duplicate broadcast. |
| AZ-BSK-3 | AZ-0623 | Medium | accepted-with-rationale | BasketVault, RobotMoneyVault | — | Deposits during adapter exclusion proceed at reduced NAV; once excluded adapter re-included, pre-exclusion depositors capture recovered NAV surplus without contributing to it. |
| AZ-BSK-4 | AZ-0623 | Medium | accepted-with-rationale | BasketVault, dapp (DepositWithdrawTab.tsx) | — | Direct vault deposit/redeem paths have no on-chain minimum-output parameter; preview is advisory only. |
| AZ-BSK-5 | AZ-0623 | Medium | accepted-with-rationale | BasketVault | — | Permissionless `reabsorbRemovedAsset` allows MEV to sandwich NAV recovery: deposit at discounted NAV → trigger reabsorption → redeem at recovered NAV. |
| AZ-BSK-6 | AZ-0623 | Medium | accepted-with-rationale | BasketVault | — | Redemptions use only vault-wide slippage floor; no per-caller `minAssetsOut`; MEV can extract up to `maxSlippageBps` within the configured band. |
| AZ-REG-1 | AZ-0623 | Medium | accepted-with-rationale | VaultRegistry, BasketVault | — | `VaultRegistry.setVaultStatus` wraps the vault retire hook in empty try/catch; if the hook fails, registry advertises non-Active status but vault `depositsPaused` is unset, allowing direct deposits. Completes the risk identified by FS-VLT-19. |
| AZ-GW-3 | AZ-0623 | Medium | accepted-with-rationale | RobotMoneyGateway, PortfolioRouter | — | Router withdrawal path skips `allowedSourceVaults` check when the array is empty; empty allowlist should mean pinned-vault-only but currently means no restriction. |
| AZ-GOV-1 | AZ-0623 | Medium | accepted-with-rationale | RouterGovernance, dapp (GovernancePanel.tsx) | — | Hard 256-block OZ snapshot cap < MIN_VOTING_PERIOD on L2; voting UI breaks for remaining voters before voting closes. |
| AZ-RPC-2 | AZ-0623 | Medium | accepted-with-rationale | rmpc (withdraw.rs, withdraw_router.rs) | — | Deposit path has local replay-cache protection; withdraw paths do not; duplicate withdrawals can be signed if first tx still pending. |
| AZ-LOW | AZ-0623 | Low (11 findings) | accepted-with-rationale | RobotMoneyGateway, rmpc, dapp, PortfolioRouter | — | Deposit-lookup misses router-path events; destination selector allows non-Active vaults; off-chain feature flags not on-chain enforced; permissionless agent-address reservation; policy expiry at exact timestamp; receipt not bound to broadcast tx; router-withdrawal wall-clock deadline; router-withdrawal zero slippage floors; keystore file permissions; share-price overflow silently saturated; vault-selector gate races during status load. All low-severity, no existing fixes. |
| AZ-INFO | AZ-0623 | Info (29 findings) | accepted-with-rationale | all components | — | Audit log rotation not cross-process synchronized; Base fee cap / priority floor incompatibility; Chronicle NAV freshness not checked in-scope; plus 26 additional info-class observations. Accepted background risk. |

### Gap analysis — process & coverage backlog (20260607-code-review-internal-claude-gap-analysis.md)

> The gap analysis enumerates 50 tracked-as-future-work items (issues #643–#692),
> not contract bugs. SECURITY-003 ("No audit ledger") is resolved by this issue
> (#1010). The remainder are open, each tracked by its GitHub issue.

| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
|---|---|---|---|---|---|---|
| SECURITY-003 | 20260607-code-review-internal-claude-gap-analysis.md | Medium | fixed | docs/audits.md, SECURITY.md | #1013, #1014 | "No audit ledger" — resolved by creating this `docs/audits.md` and the repo-root `SECURITY.md` (issue #1010) |
| SECURITY-001 | 20260607-code-review-internal-claude-gap-analysis.md | Medium | fixed | SECURITY.md | #1013, #1014 | "No SECURITY.md at repo root" — resolved by creating repo-root `SECURITY.md` (tracking issue #643) |
| GAP-BACKLOG | 20260607-code-review-internal-claude-gap-analysis.md | Critical–Low | accepted-with-rationale | architecture/security-model/CI/dapp/rmpc surfaces | — | The remaining ~48 gap items (#643–#692, e.g. MAINNET-001, WATCHDOG-001, CSP-001, bug-bounty SECURITY-002) are acknowledged future-work, each tracked by its GitHub issue; a coverage backlog, not a per-contract vulnerability |

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
| FS-0619 accepted-open (FS-RTR-1, FS-VLT-10, FS-VLT-19, FS-RPC-11 + all FS-* not fixed/dismissed) | accepted-with-rationale | 20260619-code-review-internal-claude-scan-verification.md (7 reviewer passes) | The named component before any change to that finding's code path; FS-RTR-1 / FS-VLT-10 / FS-VLT-19 / FS-RPC-11 are CONFIRMED-open with no landed fix — close before mainnet |
| MC-0619 accepted/dismissed (MC-F-12, MC-F-18, MC-F-19) | accepted-with-rationale / dismissed-with-rationale | 20260619-code-review-pekshield.md (4 reviewer passes) | PortfolioRouter cap config; IUpstreamMonitor wiring; Slither suppressions |
| HR-0618 accepted (HR-M-10 bypass-half, HR-L-9/11/13, HR-I-1…I-8, HR-L3-F1/F2) | accepted-with-rationale | 20260618-code-review-internal-claude.md (double-checked second pass) | Governance `setWeights`/admin-floor; vault redeemFor/rescue paths; adapter sentinel/oracle scaling before any major change |
| HR-0618 dismissed (HR-S-1) | dismissed-with-rationale | 20260618-code-review-internal-claude.md + Slither 0.11.5 triage | Production Solidity before re-running Slither / changing suppressions |
| CD-0602 SAFE verdicts (all CD-*) | accepted-with-rationale | 20260602-code-review-internal-claude.md | Any fund-moving entrypoint before introducing caller-supplied authority or a zero-slippage swap path |
| SR-0612 open findings (SR-0612-OPEN, SR-0612-P1) | accepted-with-rationale | 20260612-code-review-internal-claude.md | The contract-security-remediation phases must land the open SR-* fixes before mainnet; verify landing, not claimed status |
| DC-0606 deferred (DC-0606-DEFER) | accepted-with-rationale | 20260606-code-review-internal-claude.md + 20260612-code-review-internal-claude.md cross-check | Registry status caching, RouterGovernance execute() re-validation, shortlist delay, admin transfer before those upgrades |
| Gap-analysis backlog (GAP-BACKLOG) | accepted-with-rationale | 20260607-code-review-internal-claude-gap-analysis.md | Resolve each #643–#692 tracking issue before the dependent launch gate (mainnet deploy, public dapp, bucket-B/C) |
| AZ-0623 all findings (AZ-GW-1…AZ-INFO) | accepted-with-rationale | 20260623-code-review-testmachine-azimuth.md §Verification commentary (2026-06-23 in-context pass) | AZ-GW-1 / AZ-BSK-1 / AZ-RTR-2 / AZ-BSK-2 / AZ-REG-1 / AZ-GW-3 are mainnet-blocking; re-evaluate before any change to gateway authorization, BasketVault _deposit/_withdraw, PortfolioRouter deposit, VaultRegistry setVaultStatus, or router-withdrawal allowedSourceVaults logic. FS-0619 "consent is structural" dismissal superseded by AZ-GW-1. |
