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
  updating that script in the same change.

  Disposition discipline (per #1010): rows transcribe the *disposition already
  recorded in the cited snapshot* under docs/code-reviews/ and docs/code-review/.
  No finding is re-audited or re-triaged here. Where a snapshot is a
  verification/grade rather than a remediation log, the mapping rule used is:
    REFUTED / "does not reproduce" / "miscalibrated, collapses" -> dismissed-with-rationale
    MITIGATED / "closed in code with pinning test" / "fix landed" -> fixed
    CONFIRMED-open with a concrete described fix -> fixed (fix specified)
    CONFIRMED, accepted as documented/by-design/MVP risk -> accepted-with-rationale
  Each row's "Checked against" names the contract(s)/component(s) the snapshot
  verified the finding against (§14 cross-reference requirement).
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
> `docs/code-reviews/` and `docs/code-review/`. This ledger transcribes the
> dispositions those snapshots record; it does not re-audit or re-triage.

## Audit-scope ledger

<!--
  §14 "Selectively audited surface": map every production contract to the audit
  report(s) that covered it. Production Solidity = contracts/*.sol +
  contracts/{adapters,gateway,vaults,lib}/*.sol, excluding contracts/test/,
  contracts/script/, contracts/interfaces/, and the generated contracts/doc/
  mirror. No contract may ship to production without a completed audit or an
  explicit documented exception approved by the team.

  Report keys used in the table:
    VA-0609 = docs/code-review/smart-contract-vulnerability-audit-20260609.md
    HR-0618 = docs/code-review/smart-contract-holistic-review-20260618.md
    MC-0619 = docs/code-review/external-audit-verification-20260619.md (multi-contract)
    FS-0619 = docs/code-review/external-scan-verification-20260619.md (full-stack scan)
    CD-0602 = docs/code-review/confused-deputy-access-control-audit-20260602.md
    DC-0606 = docs/code-reviews/security-deep-clean-20260606.md
    SR-0612 = docs/code-reviews/security-review-20260612.md
-->

Every production contract under `contracts/` (excluding `contracts/test/`,
`contracts/script/`, `contracts/interfaces/`, and the generated
`contracts/doc/` mirror) is mapped to the audit report(s) that covered it.

| Contract | Audit report(s) | Status | Exception (if any) |
|---|---|---|---|
| `RobotMoneyVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612 | Audited | — |
| `RmToken.sol` | VA-0609, HR-0618 | Audited | — |
| `PortfolioRouter.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, SR-0612 | Audited | — |
| `RouterGovernance.sol` | VA-0609, HR-0618, MC-0619, CD-0602, SR-0612 | Audited | — |
| `VaultRegistry.sol` | VA-0609, HR-0618, MC-0619, CD-0602, SR-0612 | Audited | — |
| `FeatureFlags.sol` | VA-0609 | Audited | Pre-mainnet re-audit pending under the bucket-B/C economic-audit gate (security-model.md §14) |
| `UniswapV3PoolSlot0Stub.sol` | VA-0609, HR-0618 | Audited | Devnet/demo helper; not router-eligible. Documented exception: fail-closed at the vault, not a production swap surface |
| `gateway/RobotMoneyGateway.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612 | Audited | — |
| `gateway/AccessRoles.sol` | VA-0609, HR-0618, MC-0619, CD-0602 | Audited | — |
| `gateway/MockVault.sol` | VA-0609, HR-0618 | Audited | Test/mock surface (constructor asset-mismatch revert pinned, HR-0618 I-9); not production-reachable |
| `vaults/BasketVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, CD-0602, DC-0606, SR-0612 | Audited | Bucket-B/C economic-model audit required before router-eligible production use (security-model.md §14; gap BASKET-001/ECONOMIC-AUDIT-001) |
| `vaults/RwaVault.sol` | VA-0609, HR-0618, MC-0619, FS-0619, SR-0612 | Audited | Same bucket-B/C economic-audit gate as BasketVault |
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
  Disposition is one of the §9 enum values. Severity is the snapshot's
  (re-graded where the verification adjusted it: "orig->regrade").

  Coverage note: the large open-finding inventories in SR-0612 (49 findings,
  most "open on dev") and DC-0606 (74 claimed-fixed, 8 contradicted by SR-0612)
  and the gap-analysis backlog (50 tracked-as-future-work items, #643-#692) are
  summarized as grouped rows here with their snapshot as the authoritative
  source; the per-ID detail lives in those snapshots. The 2026-06-19 full-stack
  scan (FS-0619) and multi-contract audit (MC-0619) findings are transcribed
  per-ID below because issue #1010 requires the external-scan findings each carry
  a disposition.
-->

Disposition is one of `fixed` / `accepted-with-rationale` /
`dismissed-with-rationale` (§9). "Checked against" names the
contract(s)/component(s) the cited snapshot verified the finding against (§14).

### FS-0619 — Full-stack automated scan verification (2026-06-19, 95 findings)

The external scan reported 95 findings (6 High, 61 Medium, 28 Low, 0 Critical);
the verification (`docs/code-review/external-scan-verification-20260619.md`)
collapses 3 duplicate listings into 92 distinct IDs and re-grades severities in
both directions. The four "High access-control" contract findings collapse
(consent is structural — share movement needs the victim's own gateway
allowance). The rows below transcribe each ID's verdict and disposition.

| Finding ID | Source | Severity (orig→regrade) | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| FS-IDX-1 | FS-0619 | High→Critical | fixed | explorer-indexer, watchdog | Duplicate Withdraw handler left burn rows unwritten; top remediation item (remove dead branch, restore burn alarm) |
| FS-IDX-2 | FS-0619 | High | fixed | explorer-indexer | Failed run after reorg advanced cursor past deleted blocks; watchdog-reliability remediation |
| FS-IDX-3 | FS-0619 | Medium | accepted-with-rationale | explorer-api | Account-positions endpoint never populated; confirmed, observability-only, no fund path |
| FS-IDX-4 | FS-0619 | Medium | fixed | explorer-indexer, watchdog | Direct ERC-4626 deposits excluded from mint-volume; remediation includes registered-vault flows |
| FS-IDX-5 | FS-0619 | Medium | accepted-with-rationale | explorer-indexer | Vote tally counts voters not power; display-only, confirmed |
| FS-IDX-6 | FS-0619 | Medium | fixed | explorer-indexer, watchdog | Registry-discovered vaults missing from burn watch set; watchdog-reliability remediation |
| FS-IDX-7 | FS-0619 | Medium | fixed | explorer-indexer, watchdog | Routed deposits double-counted in mint-volume; remediation de-duplicates routed volume |
| FS-IDX-8 | FS-0619 | Medium | accepted-with-rationale | explorer-indexer | Reorg rollback doesn't revert in-place status updates; observability, no fund path |
| FS-IDX-9 | FS-0619 | Medium→down | dismissed-with-rationale | explorer-indexer | Legacy agent lookup owner-scope claim refuted as a vulnerability |
| FS-IDX-10 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | Direct ERC-4626 deposits omitted from per-account history; display gap |
| FS-IDX-11 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | Proposal status never advanced to passed/expired; display gap |
| FS-IDX-12 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | Legacy agent status marks expired policies authorized; display gap |
| FS-IDX-13 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | Policy-change history attributed to agent not owner; display attribution |
| FS-IDX-14 | FS-0619 | Low | accepted-with-rationale | explorer-indexer | Routed deposits show share receiver as vault in stats feed; display |
| FS-IDX-15 | FS-0619 | Low | accepted-with-rationale | explorer-api | Chain-scoping bypass on several reads; partial, read-only |
| FS-IDX-16 | FS-0619 | Low | accepted-with-rationale | explorer-api | Vault-detail history stale after 500-snapshot cap; display |
| FS-WD-1 | FS-0619 | Medium→High | fixed | watchdog | Pause awaited before alert, no RPC timeout, SLA unenforced; remediation adds timeouts + enforces SLA |
| FS-WD-2 | FS-0619 | Medium | accepted-with-rationale | watchdog | Hourly window uses wall-clock not chain time; confirmed, in root-cause cluster |
| FS-WD-3 | FS-0619 | Medium→Low | dismissed-with-rationale | watchdog | RLP r/s non-minimal encoding; ≈1/256 per scalar, most clients accept |
| FS-WD-4 | FS-0619 | Medium | accepted-with-rationale | watchdog | Per-vault thresholds parsed but never enforced; confirmed (collapsed dup) |
| FS-WD-5 | FS-0619 | Medium | accepted-with-rationale | watchdog | Pause retries use pending nonce, can't replace stuck tx; confirmed |
| FS-WD-6 | FS-0619 | Medium→High | fixed | watchdog | Per-block thresholds only inspect latest indexed block; remediation iterates all new blocks (collapsed dup) |
| FS-RTR-1 | FS-0619 | High→Medium | fixed | PortfolioRouter | Pre-existing USDC dust bricks router deposits; remediation adds minimum-balance carve-out (availability DoS) |
| FS-RTR-2 | FS-0619 | High→Low | fixed | RobotMoneyGateway, PortfolioRouter | Redeemer allowance-guard not consumed; already mitigated (gateway self-custodies), confused-deputy theoretical |
| FS-RTR-3 | FS-0619 | High→Low/Info | dismissed-with-rationale | PortfolioRouter, RobotMoneyGateway | "Arbitrary shareReceiver pull" refuted: plain transferFrom needs victim's own allowance; one of 4 collapsing High findings (listed twice) |
| FS-RTR-4 | FS-0619 | Medium→Low | dismissed-with-rationale | PortfolioRouter | Agent authorization needs no agent consent; `_assertRoleSeparation` blocks the AGENT_ROLE escalation |
| FS-RTR-5 | FS-0619 | Medium | accepted-with-rationale | PortfolioRouter | Commit/reveal front-run squatter DoS; nuisance, confirmed |
| FS-RTR-6 | FS-0619 | Medium→Low | accepted-with-rationale | RobotMoneyGateway | `depositTo` paymentId omits destination + minSharesPerLeg; benign, self-affecting |
| FS-RTR-7 | FS-0619 | Medium | accepted-with-rationale | PortfolioRouter | Empty `allowedSourceVaults` not enforced on router withdrawals; hardening |
| FS-RTR-8 | FS-0619 | Medium→Low | accepted-with-rationale | RobotMoneyGateway | Router withdrawals can't enforce per-leg min assets; by design (L-8) |
| FS-RTR-9 | FS-0619 | Medium→Low | accepted-with-rationale | PortfolioRouter | Router-withdrawal paymentId binds only totalShares; benign |
| FS-RTR-10 | FS-0619 | Medium→Low | accepted-with-rationale | PortfolioRouter | Rounding remainder lets tiny split deposits bypass weights; cosmetic |
| FS-VLT-1 | FS-0619 | Medium→Info | accepted-with-rationale | RobotMoneyVault | `IUpstreamMonitor` health gate not enforced; by-design stub |
| FS-VLT-2 | FS-0619 | Medium→Info | dismissed-with-rationale | AerodromeSwapAdapter | Slipstream slot0 ABI "mismatch" refuted; targets repo's own internally-consistent shim |
| FS-VLT-3 | FS-0619 | Medium | accepted-with-rationale | RwaVault, ChronicleOracleAdapter | Chronicle RWA route vs V3-style addAsset checks; latent integration |
| FS-VLT-4 | FS-0619 | Medium→Info | dismissed-with-rationale | CompoundV3Adapter | Rewards "not harvested" refuted; they accrue in share price |
| FS-VLT-5 | FS-0619 | Medium | accepted-with-rationale | RobotMoneyVault | Deposits mint on max-slippage haircut; by design (H-1) |
| FS-VLT-6 | FS-0619 | Medium→down | dismissed-with-rationale | BasketVault | "Greedy deposit reverts" refuted for HEAD (skips + idles); claim on stale `src/` |
| FS-VLT-7 | FS-0619 | Medium | dismissed-with-rationale | RobotMoneyVault | "Idle assets excluded from totalAssets" refuted; HEAD includes idle |
| FS-VLT-8 | FS-0619 | Medium→down | accepted-with-rationale | RobotMoneyVault | Idle-first withdrawals; matches HEAD, benign |
| FS-VLT-9 | FS-0619 | Medium | accepted-with-rationale | BasketVault | Inactive asset entries consume basket capacity; low impact |
| FS-VLT-10 | FS-0619 | Medium | fixed | MorphoAdapter | Morpho reports illiquid shares as withdrawable; remediation caps pulls by maxWithdraw |
| FS-VLT-11 | FS-0619 | Medium | dismissed-with-rationale | BasketVault, MorphoAdapter | Stale duplicate of FS-VLT-10 |
| FS-VLT-12 | FS-0619 | Medium→down | accepted-with-rationale | VaultRegistry, vault | Registry Paused doesn't halt direct deposits; router gates by design |
| FS-VLT-13 | FS-0619 | Medium | accepted-with-rationale | RwaVault | RWA redemption blocked by price deviation from NAV; by design (ADR-0006) |
| FS-VLT-14 | FS-0619 | Medium→Info | dismissed-with-rationale | RwaVault, ChronicleOracleAdapter | RWA freshness `latestTimestamp()` "noncanonical" refuted; own IChronicleOracle |
| FS-VLT-15 | FS-0619 | Medium→down | fixed | RobotMoneyVault | Receipt-token donation inflation mitigated by 1e18 `_decimalsOffset` |
| FS-VLT-16 | FS-0619 | Medium→Info | dismissed-with-rationale | UniswapV4SwapAdapter | "Noncanonical router ABI" refuted; own shim |
| FS-VLT-17 | FS-0619 | Medium | accepted-with-rationale | UniswapV4SwapAdapter | V4 pricing assumes V3 observe() pool; demo vault, not router-eligible |
| FS-VLT-18 | FS-0619 | Medium | fixed | VaultRegistry, vault | Retire leaves router-eligibility state stale; remediation implements retire()/unretire() |
| FS-VLT-19 | FS-0619 | Medium | fixed | VaultRegistry, BasketVault | Registry retire() reverts on basket subclasses; remediation implements retire on subclasses |
| FS-VLT-20 | FS-0619 | Medium→down | accepted-with-rationale | BasketVault | Withdrawals/rebalance push adapters above caps; by design, re-converges |
| FS-VLT-21 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | `redeem()` return diverges from USDC transferred; confirmed, minor |
| FS-VLT-22 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | Exact-asset withdraw overcharges fee (ceil gross-up); ±1 unit dust |
| FS-VLT-23 | FS-0619 | Low | accepted-with-rationale | RobotMoneyVault | Exit fee rounds to zero on dust chunks; ±1 unit dust |
| FS-VLT-24 | FS-0619 | Medium→down | dismissed-with-rationale | RobotMoneyVault | "maxWithdraw unwithdrawable" refuted; L-1 floor fix is a counter-example |
| FS-VLT-25 | FS-0619 | Low→Medium | fixed | RobotMoneyVault | Emergency-unwind deposit-pause uncleanable; remediation adds a Pausable-independent clear |
| FS-VLT-26 | FS-0619 | Low | accepted-with-rationale | BasketVault | Dust donations block asset removal; confirmed, minor |
| FS-VLT-27 | FS-0619 | Low→Info | accepted-with-rationale | RobotMoneyVault | `decimals()=6` vs `_decimalsOffset()=18`; documented |
| FS-RPC-1 | FS-0619 | Medium | accepted-with-rationale | rmpc | `get-agent` uses deprecated calendar-window gross; confirmed |
| FS-RPC-2 | FS-0619 | Medium→High(local) | fixed | rmpc | Replay cache written before receipt success; remediation adds remove/finalize-on-failure |
| FS-RPC-3 | FS-0619 | Medium | fixed | rmpc | Failover stops on transient indexing error; remediation treats transient RPC as retryable |
| FS-RPC-4 | FS-0619 | Medium | fixed | rmpc | Missing `result` accepted as null receipt; remediation paired with FS-RPC-3 |
| FS-RPC-5 | FS-0619 | Medium→High | fixed | rmpc | Vote proposal-id parsed hex-before-decimal; remediation parses decimal-first |
| FS-RPC-6 | FS-0619 | Medium→Low | dismissed-with-rationale | rmpc | Keystore files not 0600; downgraded — contents are an encrypted blob |
| FS-RPC-7 | FS-0619 | Medium→High(router) | fixed | rmpc | Withdraw preflight omits share allowance/balance; remediation adds real checks |
| FS-RPC-8 | FS-0619 | Low | accepted-with-rationale | rmpc | Agent-expiry preflight uses wall-clock; confirmed, minor |
| FS-RPC-9 | FS-0619 | Low | fixed | rmpc | Deposit/status logs unbounded by envelope block; remediation pins reads to sampled block |
| FS-RPC-10 | FS-0619 | Low | accepted-with-rationale | rmpc | Keystore import leaves key in non-zeroized buffers; confirmed, minor |
| FS-RPC-11 | FS-0619 | Low | fixed | rmpc | Pending timelock ops dropped on getTimestamp failure; remediation surfaces partial/errors |
| FS-RPC-12 | FS-0619 | Low | accepted-with-rationale | rmpc | Router deposits share vault-deposit replay namespace; confirmed, minor |
| FS-RPC-13 | FS-0619 | Low | fixed | rmpc | Self-check reports zero allowance on read failure; remediation surfaces partial/errors |
| FS-RPC-14 | FS-0619 | Low | fixed | rmpc, dapp | Role membership ignores grant/revoke chronology; remediation adds chronology-aware reconstruction |
| FS-RPC-15 | FS-0619 | Low | fixed | rmpc | `get-tx` receipt postdates envelope block; pin-block fix (FS-RPC-9 class) |
| FS-RPC-16 | FS-0619 | Low | fixed | rmpc | Unpinned balance/allowance reads; pin-block fix (FS-RPC-9 class) |
| FS-RPC-17 | FS-0619 | Low→Info | dismissed-with-rationale | rmpc | Vault share-price overflow saturates; overflow needs absurd decimals/supply, unreachable |
| FS-RPC-18 | FS-0619 | Low | accepted-with-rationale | rmpc | Withdraw flows omit local replay-cache checks; confirmed, minor |
| FS-HARN-1 | FS-0619 | Medium→Info/Low | dismissed-with-rationale | smoke-test/fork-e2e harness | Checked-in devnet faucet key; by-design throwaway genesis key, controls nothing of value |
| FS-HARN-2 | FS-0619 | Medium | accepted-with-rationale | harness, dapp build | Faucet key in public bundle + tunnel + printed; confirmed (devnet-only) |
| FS-HARN-3 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | Holder allowances/blacklist not scrubbed; requires control of committed fixtures |
| FS-HARN-4 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | Ingested impl account bypasses seed bytecode; requires control of committed fixtures |
| FS-HARN-5 | FS-0619 | Medium | accepted-with-rationale | harness | Pinned manifest doesn't authenticate snapshot bytes; supply-chain hardening |
| FS-HARN-6 | FS-0619 | Medium | accepted-with-rationale | harness | USDC grant ignores packed blacklist bit (V2_1/V2_2); robustness bug |
| FS-HARN-7 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | Seed can preserve minter authority; requires control of committed fixtures |
| FS-HARN-8 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | Seed not tied to pinned manifest; requires control of committed fixtures |
| FS-HARN-9 | FS-0619 | Medium→Low | dismissed-with-rationale | harness | New run force-removes other runs' containers; local concurrent-run DoS only |
| FS-DAPP-1 | FS-0619 | Medium | accepted-with-rationale | dapp | Governance UI gates on current power not snapshot; confirmed |
| FS-DAPP-2 | FS-0619 | Medium | accepted-with-rationale | dapp | Router deposit UI submits zero per-leg share floors; confirmed |
| FS-DAPP-3 | FS-0619 | Medium→Low | dismissed-with-rationale | dapp | Stale-allowance UI checks agent not shareReceiver allowance; unwired dead code |
| FS-DAPP-4 | FS-0619 | Medium→High | fixed | dapp | Destination selector doesn't control direct-deposit target; remediation threads selected vault into single-vault path |
| FS-DAPP-5 | FS-0619 | Low→Medium | fixed | dapp | `VaultDetail` decodes shortlist as structs not parallel arrays; remediation fixes ABI |
| FS-DAPP-6 | FS-0619 | Low | fixed | dapp, rmpc | Timelock panel ignores grant/revoke chronology; shared chronology-aware fix (mirrors FS-RPC-14) |

### MC-0619 — Multi-contract lifecycle audit verification (2026-06-19, F-01…F-19)

External multi-contract audit (1 High, 9 Medium, 5 Low, 4 Info). 17 of 18
substantive findings reproduce against HEAD; F-04 rests on a stale premise.
No unauthenticated EOA fund-drain; the real surface is lifecycle state composed
across contracts and where privileged roles land after deploy.

| Finding ID | Source | Severity | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| MC-F-01 | MC-0619 | High | fixed | RobotMoneyGateway, AccessRoles, DeployTimelock/Deploy scripts | Timelock handover incomplete (deployer EOA stays root + holds vault EMERGENCY_ROLE); remediation grants admin/emergency to timelock + broadens deploy assertions |
| MC-F-02 | MC-0619 | Medium | fixed | PortfolioRouter | Redeem leg requires Active, conflicts with Retired withdraw-only; remediation allows Active or Retired in `_redeemLeg` |
| MC-F-03 | MC-0619 | Medium | fixed | PortfolioRouter | Redeem iterates live weights not balances; remediation drives legs from `listVaults()`/caller `vaults[]` |
| MC-F-04 | MC-0619 | Medium | fixed | RobotMoneyVault, VaultRegistry | Registry/vault flag drift mostly fixed by atomic retire() (#933/#958); narrow residual back-door with described fix |
| MC-F-05 | MC-0619 | Medium | fixed | PortfolioRouter | `setWeights` can write a non-depositable weight vector; remediation requires Active per weighted vault |
| MC-F-06 | MC-0619 | Medium | fixed | RobotMoneyVault, BasketVault, AccessRoles | Admin-floor inconsistent; remediation inherits `AdminFloorAccessControl` on vaults + gateway |
| MC-F-07 | MC-0619 | Medium | fixed | BasketVault, RwaVault | `shutdownVault` irreversible; remediation adds ADMIN-gated `restoreVault` |
| MC-F-08 | MC-0619 | Medium | fixed | RwaVault | Stale-override + unwind under one EMERGENCY key; remediation gates behind ADMIN/timelock |
| MC-F-09 | MC-0619 | Medium | fixed | UniswapV4SwapAdapter, AerodromeSwapAdapter, BasketVault | TWAP quote pool may mismatch execution pool; remediation asserts execution-pool == TWAP-pool in `addAsset` |
| MC-F-10 | MC-0619 | Medium | fixed | RwaVault, ChronicleOracleAdapter | No NAV-vs-market deviation guard; remediation adds bounded deviation check |
| MC-F-11 | MC-0619 | Low | fixed | RobotMoneyGateway | Gateway zeroes router per-leg floor + disables deadline; remediation forwards `minAssetsPerLeg[]` into intent hash |
| MC-F-12 | MC-0619 | Low | accepted-with-rationale | PortfolioRouter | Router cap per-tx only, splittable; documented as per-tx sanity bound (fix-or-document accepted) |
| MC-F-13 | MC-0619 | Low | fixed | PortfolioRouter | Deposit all-or-revert diverges from preview; remediation makes execute skip-and-renormalise |
| MC-F-14 | MC-0619 | Low | fixed | RobotMoneyVault | Revoked-but-active adapter still trusted for NAV; remediation tightens revoke→drain→remove window |
| MC-F-15 | MC-0619 | Low | fixed | RobotMoneyGateway | Idempotency hash omits destination + per-leg shares; remediation folds them in |
| MC-F-16 | MC-0619 | Info | fixed | RobotMoneyVault, MorphoAdapter, BasketVault | NAV trusts subcomponent prices, TWAP marks; remediation adds per-block NAV-delta bound + round-trip test |
| MC-F-17 | MC-0619 | Info | fixed | ChronicleOracleAdapter, BasketVault | Hardcoded 18-dec scaling + reabsorb reuses stale pool; remediation reads decimals dynamically + quarantine fallback |
| MC-F-18 | MC-0619 | Info | accepted-with-rationale | IUpstreamMonitor | Upstream health monitor interface-only stub (#702); deferred by design |
| MC-F-19 | MC-0619 | Info | dismissed-with-rationale | Slither output | Meta-comment; mostly known/low-risk patterns, no new action |

### VA-0609 / HR-0618 — Vulnerability audit + holistic remediation verification

The 2026-06-09 vulnerability audit (H-1, M-1…M-10, L-1…L-17, I-1…I-10) verified
against HEAD by the 2026-06-18 holistic review, which is the authoritative
disposition source. Every High/Medium is closed in code with a pinning
regression test except M-10 (split: vote-snapshot half fixed, `setWeights`-bypass
half accepted as the documented multisig+timelock MVP property).

| Finding ID | Source | Severity | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| HR-H-1 | VA-0609/HR-0618 | High | fixed | BasketVault | `mint()` slippage-haircut bypass; symmetric `previewMint` gross-up, pinned |
| HR-M-1 | VA-0609/HR-0618 | Medium | fixed | ChronicleOracleAdapter | Rejects zero/degenerate oracle price; bounds pinned |
| HR-M-2 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyVault | `withdraw(maxWithdraw)` 4626 violation; fee-enabled conformance suite |
| HR-M-3 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyVault | `forceRemoveAdapter` now pauses deposits; pinned |
| HR-M-4 | VA-0609/HR-0618 | Medium | fixed | RwaVault, BasketVault | RWA emergency unwind staleness gate on both paths; pinned |
| HR-M-5 | VA-0609/HR-0618 | Medium | fixed | PortfolioRouter | `redeemFor` caller authorization enforced; pinned |
| HR-M-6 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyGateway | Per-window cap true sliding window; pinned + fuzz |
| HR-M-7 | VA-0609/HR-0618 | Medium | fixed | RobotMoneyGateway | Caller-bound commit/reveal; pinned |
| HR-M-8 | VA-0609/HR-0618 | Medium | fixed | BasketVault | Redeem-only enforcement for 4626 exactness; pinned |
| HR-M-9 | VA-0609/HR-0618 | Medium | fixed | RouterGovernance | `MIN_EXECUTION_DELAY` in setter + constructor; pinned |
| HR-M-10 | VA-0609/HR-0618 | Medium | accepted-with-rationale | RouterGovernance, PortfolioRouter | Vote-snapshot half fixed (pinned); `setWeights`-bypass half accepted as documented multisig+timelock MVP property (overall status: partial) |
| HR-L-1 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | max-* views zeroed while withdrawals paused; pinned |
| HR-L-2 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | `_pullProportional` last-adapter sweep/clamp DoS; pinned |
| HR-L-3 | VA-0609/HR-0618 | Low | accepted-with-rationale | RobotMoneyVault | Irreversible `shutdownVault` under EMERGENCY_ROLE; in-trust-model, fix-before-mainnet noted |
| HR-L-4 | VA-0609/HR-0618 | Low | fixed | RobotMoneyVault | Allowlist revocation no longer bricks deposits (skips ineligible adapter); pinned |
| HR-L-5 | VA-0609/HR-0618 | Low | fixed | AerodromeSwapAdapter, ChronicleOracleAdapter, UniswapV4SwapAdapter | Caller deadline forwarded; pinned |
| HR-L-6 | VA-0609/HR-0618 | Low | fixed | UniswapV4SwapAdapter | SafeCast on uint128 truncation; pinned |
| HR-L-7 | VA-0609/HR-0618 | Low | fixed | AerodromeSwapAdapter, ChronicleOracleAdapter | Unchecked router return-array indexing; structural rewrite (Chronicle secondary site lacks dedicated test) |
| HR-L-8 | VA-0609/HR-0618 | Low | accepted-with-rationale | PortfolioRouter | `redeemFor` no slippage/deadline; in-trust-model, fix-before-mainnet noted |
| HR-L-9 | VA-0609/HR-0618 | Low | accepted-with-rationale | PortfolioRouter | `setWeights` accepts duplicate vault entries; admin-gated, accepted |
| HR-L-10 | VA-0609/HR-0618 | Low | accepted-with-rationale | PortfolioRouter, RouterGovernance, VaultRegistry | Self-administered ADMIN_ROLE no floor; governance-liveness risk, fix-before-mainnet noted |
| HR-L-11 | VA-0609/HR-0618 | Low | accepted-with-rationale | PortfolioRouter | `rescueUsdc` unconditional admin sweep; accepted by design (custody invariant limits blast radius) |
| HR-L-12 | VA-0609/HR-0618 | Low | fixed | RobotMoneyGateway | `withdrawFromRouter` paymentId OP-prefix added; pinned |
| HR-L-13 | VA-0609/HR-0618 | Low | accepted-with-rationale | RobotMoneyGateway | `withdraw` pulls shares from agent not shareReceiver; WONTFIX-by-design, documented + test-covered |
| HR-L-14 | VA-0609/HR-0618 | Low | fixed | AccessRoles | Role-separation override honors DEFAULT_ADMIN_ROLE; pinned |
| HR-L-15 | VA-0609/HR-0618 | Low | fixed | BasketVault | Removed assets rescuable if tokens reappear; pinned |
| HR-L-16 | VA-0609/HR-0618 | Low | fixed | BasketVault | `maxDeposit`/`maxMint` honor caps/shutdown/pause; pinned |
| HR-L-17 | VA-0609/HR-0618 | Low | fixed | BasketVault | `setMaxSlippageBps(0)` pool-fee floor; pinned |
| HR-I-1 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | Adapter array never compacted; bounded by MAX_ADAPTERS active cap |
| HR-I-2 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyVault | Exit-fee dust floors to zero; accepted by design |
| HR-I-3 | VA-0609/HR-0618 | Info | accepted-with-rationale | MorphoAdapter | `max` sentinel ignored; out-of-trust-model, vault never passes max |
| HR-I-4 | VA-0609/HR-0618 | Info | accepted-with-rationale | RmToken | approve race / infinite allowance; devnet token, not mainnet-ready |
| HR-I-5 | VA-0609/HR-0618 | Info | accepted-with-rationale | UniswapV3PoolSlot0Stub | No chain-id guard; demo-only, fail-closed at vault |
| HR-I-6 | VA-0609/HR-0618 | Info | accepted-with-rationale | UniswapV4SwapAdapter | No fee-on-transfer delta check; admin-curated input, out of trust model |
| HR-I-7 | VA-0609/HR-0618 | Info | accepted-with-rationale | VaultRegistry | Stores `asset` without 4626 cross-check; admin-only, router re-derives |
| HR-I-8 | VA-0609/HR-0618 | Info | accepted-with-rationale | RobotMoneyGateway | Unbounded AgentPolicy whitelist arrays; owner-self-DoS, out of trust model |
| HR-I-9 | VA-0609/HR-0618 | Info | fixed | MockVault | Constructor asset-mismatch revert; pinned, not production-reachable |
| HR-I-10 | VA-0609/HR-0618 | Info | fixed | ChronicleOracleAdapter | Hardcoded `WAD*1e12` scaling documented + `UnknownPricePair` revert tests |
| HR-L3-D1 | HR-0618 | Low | accepted-with-rationale | BasketVault, lib/TickMath | Externalized NAV math via deploy-linked library; `pure`, byte-identical, residual mis-link operational risk |
| HR-L3-F1 | HR-0618 | Info | accepted-with-rationale | BasketVault | Per-leg sell flooring can dip redeem below preview; dust-bounded (<1¢), documented (ADR-0007) |
| HR-L3-F2 | HR-0618 | Info | accepted-with-rationale | RobotMoneyGateway | `revokeAgent` leaves rolling-window state uncleared; conservative, self-healing within window |
| HR-L3-D2 | HR-0618 | Info | accepted-with-rationale | script/AdapterBytecodeGuard | Stale natspec lists Passthrough; doc-only drift, no code path |
| HR-S-1 | HR-0618 | Info | dismissed-with-rationale | Slither (production source) | 0 High, 0 true-positive Medium; all hits known-safe patterns, no action |

### CD-0602 — Confused-deputy / caller-supplied-identity audit

Defense-in-depth audit (SquidRouterModule class) of every fund-moving entrypoint
across the 6 core contracts. All entrypoints verdict SAFE — no caller-supplied
authority fund path, no `amountOutMin=0` path; all pools ADMIN-registered. The
audit is narrowly scoped to caller-supplied-identity (later liveness/DoS bugs
found by SR-0612 do not contradict it).

| Finding ID | Source | Severity | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| CD-GATEWAY | CD-0602 | Info | accepted-with-rationale | RobotMoneyGateway (10 entrypoints) | Authority always from `msg.sender`/policy, never calldata — SAFE |
| CD-ROUTER | CD-0602 | Info | accepted-with-rationale | PortfolioRouter (8 entrypoints) | `depositFor` receiver trusted because gateway is the trust boundary — SAFE |
| CD-GOV | CD-0602 | Info | accepted-with-rationale | RouterGovernance (7 entrypoints) | Role-gated / eligibility-checked — SAFE |
| CD-REGISTRY | CD-0602 | Info | accepted-with-rationale | VaultRegistry (4 entrypoints) | ADMIN_ROLE gated — SAFE |
| CD-VAULT | CD-0602 | Info | accepted-with-rationale | RobotMoneyVault (7 entrypoints) | Standard ERC-4626 + role gates — SAFE |
| CD-BASKET | CD-0602 | Info | accepted-with-rationale | BasketVault (6 entrypoints) | TWAP slippage floors + ADMIN pool registration — SAFE |
| CD-OVERALL | CD-0602 | Info | accepted-with-rationale | All 6 core contracts | No confused-deputy gaps; no amountOutMin=0 path, all pools ADMIN-registered |

### SR-0612 / DC-0606 — Remediation-drift review + deep-clean (grouped)

> These two snapshots are recorded as grouped rows: SR-0612 is the authoritative
> source and proves several DC-0606 "fixed" claims never landed on `dev`. Per-ID
> detail (SR-H1…SR-P2, DC VAULT/AC/RUST/FIND IDs) lives in the cited snapshots.

| Finding ID | Source | Severity | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| SR-0612-OPEN | SR-0612 | High–Medium | accepted-with-rationale | RobotMoneyGateway, PortfolioRouter, RobotMoneyVault, BasketVault, RwaVault, RouterGovernance, ChronicleOracleAdapter, AerodromeSwapAdapter | 4 High + 19 Medium + 14 Low + 10 Info open on `dev` (or with fixes only on the unmerged remediation phase branch); each is a known, acknowledged risk pending the contract-security-remediation phases |
| SR-0612-P1 | SR-0612 | Process | accepted-with-rationale | docs/code-reviews/security-deep-clean-20260606.md | Audit/remediation drift: DC-0606 claimed fixes (VAULT-002, VAULT-006, ORA-001/AC-005, MEV-001, AC-006, GOV-001/AC-002, VaultRegistry asset check) never landed on `dev`; recorded so this ledger reflects landing status, not claimed status |
| DC-0606-LANDED | DC-0606 | High–Info | fixed | RobotMoneyVault, BasketVault, RobotMoneyGateway, RouterGovernance, ChronicleOracleAdapter, UniswapV4SwapAdapter, explorer-indexer, rmpc, dapp | ~63 deep-clean findings landed (5 Critical/High + Medium/Low/Info), each with a described fix; excludes the 8 contradicted-by-SR-0612 claims (above) and the 4 deferred items (below) |
| DC-0606-DEFER | DC-0606 | Deferred | accepted-with-rationale | VaultRegistry, RouterGovernance, BasketVault/AgentTokenVault, admin-transfer surface | 4 deferred items (RMDA-003 stale cached status, GOV-003 execute() re-validation, VAULT-011 SHORTLIST_ADD_DELAY, AC-008 two-step admin transfer); NatSpec invariant added, full fix needs governance/interface upgrade |

### Gap analysis — process & coverage backlog (gap-analysis-20260607.md)

> The gap analysis enumerates 50 tracked-as-future-work items (issues #643–#692),
> not contract bugs. SECURITY-003 ("No audit ledger") is resolved by this issue
> (#1010). The remainder are open, each tracked by its GitHub issue.

| Finding ID | Source | Severity | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| SECURITY-003 | gap-analysis-20260607.md | Medium | fixed | docs/audits.md, SECURITY.md | "No audit ledger" — resolved by issue #1010 creating this `docs/audits.md` and the repo-root `SECURITY.md` |
| SECURITY-001 | gap-analysis-20260607.md | Medium | fixed | SECURITY.md | "No SECURITY.md at repo root" — resolved by issue #1010 creating repo-root `SECURITY.md` (tracking issue #643) |
| GAP-BACKLOG | gap-analysis-20260607.md | Critical–Low | accepted-with-rationale | architecture/security-model/CI/dapp/rmpc surfaces | The remaining ~48 gap items (#643–#692, e.g. MAINNET-001, WATCHDOG-001, CSP-001, bug-bounty SECURITY-002) are acknowledged future-work, each tracked by its GitHub issue; this is a coverage backlog, not a per-contract vulnerability |

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
| FS-0619 dismissed (FS-IDX-9, FS-WD-3, FS-RTR-3/4, FS-VLT-2/4/6/7/11/14/16/24, FS-RPC-6/17, FS-HARN-1/3/4/7/8/9, FS-DAPP-3) | dismissed-with-rationale | external-scan-verification-20260619.md (7 reviewer passes) | The named component before any change to indexer/watchdog/router/gateway/vault/adapter/rmpc/harness/dapp logic those IDs touch |
| FS-0619 accepted (all FS-* not fixed/dismissed) | accepted-with-rationale | external-scan-verification-20260619.md (7 reviewer passes) | The named component before any change to that finding's code path |
| MC-0619 accepted/dismissed (MC-F-12, MC-F-18, MC-F-19) | accepted-with-rationale / dismissed-with-rationale | external-audit-verification-20260619.md (4 reviewer passes) | PortfolioRouter cap config; IUpstreamMonitor wiring; Slither suppressions |
| HR-0618 accepted (HR-M-10 bypass-half, HR-L-3/8/9/10/11/13, HR-I-1…I-8, HR-L3-D1/F1/F2/D2) | accepted-with-rationale | smart-contract-holistic-review-20260618.md (double-checked second pass) | Governance `setWeights`/admin-floor; vault shutdown/redeemFor/rescue paths; adapter sentinel/oracle scaling before any major change |
| HR-0618 dismissed (HR-S-1) | dismissed-with-rationale | smart-contract-holistic-review-20260618.md + Slither 0.11.5 triage | Production Solidity before re-running Slither / changing suppressions |
| CD-0602 SAFE verdicts (all CD-*) | accepted-with-rationale | confused-deputy-access-control-audit-20260602.md | Any fund-moving entrypoint before introducing caller-supplied authority or a zero-slippage swap path |
| SR-0612 open findings (SR-0612-OPEN, SR-0612-P1) | accepted-with-rationale | security-review-20260612.md | The contract-security-remediation phases must land the open SR-* fixes before mainnet; verify landing, not claimed status |
| DC-0606 deferred (DC-0606-DEFER) | accepted-with-rationale | security-deep-clean-20260606.md + security-review-20260612.md cross-check | Registry status caching, RouterGovernance execute() re-validation, shortlist delay, admin transfer before those upgrades |
| Gap-analysis backlog (GAP-BACKLOG) | accepted-with-rationale | gap-analysis-20260607.md | Resolve each #643–#692 tracking issue before the dependent launch gate (mainnet deploy, public dapp, bucket-B/C) |
