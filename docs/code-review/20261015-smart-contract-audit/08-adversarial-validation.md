# Adversarial validation — 2026-10-16

**Verdict: audit incomplete; no release sign-off.** The latest review folder is this directory. Its October 16 design dispositions are not sufficient evidence of safety. This addendum supersedes the evidence status and dispositions below; the earlier chapters remain a record of the original source pass.

## Target and provenance

- Checkout: `review/contracts-security-20261015`, HEAD `aa471faf0be462e401977b9b60054424a358d85e`.
- Initial working tree was clean. This pass adds audit documents and characterization tests, with no production Solidity edits.
- `HEAD:contracts` and `f828eabb:contracts` both resolve to `cec62bfec6e13350b61c379ba43d79a101334a3e` before these additions. The reviewed contract source therefore matches the QA baseline.
- All 255 commits returned by `git shortlog -sne HEAD -- contracts docs/code-review` have author `lucky-tensor <77554843+lucky-tensor@users.noreply.github.com>`. The latest 12 commits have that author too. This is commit metadata, not a correctness or cryptographic identity attestation. The owner explicitly authorized the audit.
- Forge 1.8.3 (`cae51ad458f6abb64852b7709eb784352429825d`); Solidity 0.8.24; optimizer enabled, 100 runs; Cancun EVM. Dependency gitlinks: forge-std `620536fa5277db4e3fd46772d5cbc1ea0696fb43`, OpenZeppelin contracts `dbb6104ce834628e473d2173bbc9d47f81a9eec3`, upgradeable contracts `723f8cab09cdae1aca9ec9cc1cfa040c2d4b06c1`.
- Scope for this pass: the contract review set and supporting authority, deployment, and evidence boundaries. No live-chain state, deployed implementation, Safe ownership, or external venue liquidity was established.

## Findings and challenged dispositions

The [new PoCs](../../../contracts/test/AuditAdversarial20261016.t.sol) are **characterization tests**: a pass demonstrates the disputed behavior, not remediation. They use production vault, linked-library, and gateway code behind local proxies with existing token/venue mocks. They do not prove current production exposure.

| ID | Adversarial verdict | Reproduction / evidence | Impact and limits |
| --- | --- | --- | --- |
| VA-01 | Confirmed locally; retain Low interface defect. | `test_audit_mintIssuesMoreSharesThanRequested`: request `100e6 * 1e18` raw shares; pay `101010102` USDC base units; receive `101010102 * 1e18` shares. | Realized-NAV accounting backs the extra shares, so this is not demonstrated dilution. It still violates exact-share `mint` semantics; the PRD does not waive the exposed interface contract. |
| VA-02 | Confirmed locally; retain Low integration defect. | `test_audit_maxViewsOverstateExecutableLiquidity`: a two-adapter vault reports `maxWithdraw = 100e6` and all holder shares as `maxRedeem`; both attempted operations revert when one venue refuses withdrawal. | Positive NAV is not executable liquidity. This mock demonstrates the discrepancy, not the liquidity of a deployed Aave/Compound/Morpho market. Conservative limits and interface disclosure still need a design decision. |
| VA-03 | Confirmed and broadened; retain Low for measured cases. | `test_audit_positivePreviewAllDustPaysZero`: deposit 4 USDC base units into two tick-zero legs; preview is 3, payout is 0, all shares burn, and two units of each token remain. `test_audit_nonDustRedeemCanMissPreviewByOneUnit`: a 100-USDC single-leg redemption previews 99 USDC but successfully pays 98.999999 USDC. | The discrepancy also occurs outside an all-dust basket. `_sellProportional` prices `sellAmount - 1`, whereas the preview discounts aggregate NAV. Both tests run preview and execution in the same transaction. No timing change or hostile governor is needed. These fixtures do not bound discrepancies across every token decimal/price configuration. |
| GW-GOV-1 | Confirmed locally; retain Low stale-consent/specification defect. | `test_audit_expiredAgentConsentAcceptedWithFreshOwnerCommit`: agent consent ages beyond `COMMIT_EXPIRY_BLOCKS`; a fresh owner commitment permits the old exact reveal. | Requires prior exact consent, an unowned agent address, and a still-valid policy. It is not arbitrary third-party agent capture. Policy expiration still applies. |
| C-03-02 | **Reopen as an unresolved custody/recoverability risk. The prior dismissal is unsupported.** | `test_audit_degradedReabsorbIgnoresCallerFloorAndLeavesCustody`: after legitimate empty removal and a reappearing 7-USDC-value balance, a stranger triggers the oracle-failure branch. All tokens go to `0x0000000000000000000000000000000000deaD11`, even with `minUsdcOut = uint256.max`; vault NAV receives nothing. | The transfer is reproduced. Permanent loss on a live chain is **not** established. Recovery/control of the destination is unproven, so do not assign a confirmed theft/loss severity or count it as safely closed. |
| C-03-01 | Retain conditional V3 configuration gap; not behaviorally reproduced here. | Registration checks pair, fee, liquidity/history; execution chooses its pool through the router. The current review gives no canonical factory-identity assertion for V3. | Requires authorized registration of a mismatched pool. Do not present the illustrative loss calculation as measured impact. |
| UD-01 | Process limitation, not demonstrated current exploit. | Same-checkout layout/snapshot equality does not establish compatibility with a previous release. | A documented review requirement can be the chosen control, but the remaining human dependency must stay explicit. No upgrade was executed. |
| UD-02 | Operational upgrade readiness remains unverified. | Upgrade/freeze operator rows are planned; the contract trusts the timelock. | Planned work is not an on-chain authorization bypass. It also cannot support operational readiness before it is implemented and verified. |
| UD-03 | Retain an unverified namespace-slot checker gap. | Snapshot normalization records namespace declarations, not the assembly slot expression. Existing self-tests pass, but do not mutate compiled slot constants. | No source-slot mutation test or incompatible upgrade was executed in this pass. The previous Medium label remains provisional, not a confirmed live vulnerability. |

The normative interface reference is [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626): `mint` issues the requested share count, maximum-operation views must not overstate accepted amounts, and same-transaction redemption must meet its preview. Intentional deviations require explicit integration treatment; documentation of an implementation choice does not prove conformance.

### Why the quarantine dismissal fails

The [security model](../../technical/security-model.md) describes the fallback, while [PRD §12](../../prd.md#12-security-invariants) promises holder recovery/NAV absorption and an offline multisig recovery process. Describing the transfer does not demonstrate that the destination supports that promise.

`ForeignTokenQuarantine.sol:24-27` claims an offline multisig can empty the destination; its comments at `:34-46` also claim BasketVault has a timelock-settable `quarantineAddress`. BasketVault actually uses the fixed destination and has no such setter. `BasketVault.t.sol:588-615` only asserts departure from the vault and arrival at that address; it never exercises recovery. A passing transfer test is therefore not evidence of recoverability.

Required closure evidence: chain-specific ownership/control or executable recovery code for the exact address, a successful recovery exercise returning assets to the proper holders/NAV, and reconciliation of the contradictory source comments and PRD. If that evidence cannot be supplied, redesign the destination/fallback. A temporary oracle failure must not make an irreversible custody assumption disappear from the risk register.

### Historical finding omitted from the latest closeout

**FS-RTR-2 remains a source-level revalidation lead.** `docs/audits.md:257` labels the allowance guard fixed/mitigated, but `PortfolioRouter._redeemLeg` (`:1062-1073`) reads the holder-to-caller allowance and then calls `vault.redeem`, which consumes the holder-to-router allowance instead. The former allowance is not consumed by the router. A non-owner with a small allowance and a holder with a larger router allowance may therefore reuse the former allowance across repeated calls or repeated vault legs.

This pass has **not executed that sequence**. Do not call it a new confirmed drain. The June verification already noticed the unconsumed allowance; gateway self-custody mitigates the normal gateway route, not necessarily the public direct router route. Required next test: use a production share token, a finite holder-to-caller allowance, a larger holder-to-router allowance, and repeated redemptions to a caller-controlled recipient; assert cumulative shares burned against the delegated allowance. Include a holder-only control case and the gateway self-custody case. Keep this separate from the invariant catalog's unrelated `RTR-2` ID.

## Actual verification results

Saved evidence: [PoC results](evidence-20261016/poc-results.txt), [baseline failures](evidence-20261016/baseline-failures.txt), [storage checks](evidence-20261016/storage-layout.txt), and [static-analysis alerts](evidence-20261016/slither-results.json).

| Check | Result | Interpretation |
| --- | --- | --- |
| Baseline `forge test --no-match-path 'contracts/test/fork/**' --summary` | **1,863 passed, 14 failed, 30 skipped**, 142 suite rows. | This exclusion pattern does not exclude root-level `*Fork.t.sol` suites. The recorded failures/skips, rather than the command's name, define the evidence. The suite ran before the new PoC file was compiled. Inherited tests duplicate some cases. |
| `forge test --match-path contracts/test/AuditAdversarial20261016.t.sol --match-test test_audit_ -vv` | **6 passed, 0 failed, 0 skipped.** | Six new characterization cases only; inherited tests were filtered out. |
| `scripts/ci/check-core-storage-layout.sh --selftest` and default comparison | All self-test cases passed; all ten core snapshots and dependency pins match. | Tests snapshot normalization/comparison, not compatibility with a deployed baseline or slot-constant mutations. |
| `slither . --json /tmp/contracts-security-20261016-slither.json` | Analysis completed: 143 contracts, 102 detectors, **229 alerts**. | Alert counts are not confirmed vulnerability counts. The scan includes dependencies in its analyzed contract count and filters report paths using the repository config. Full triage remains open. |

### Baseline failures: four causes, not fourteen distinct vulnerabilities

1. **Broken custody guard (one failure):** `CustodyInvariantGuard.t.sol:26` allocates 20 strings and `:49` writes `paths[20]`. `test_INV1_noArbitraryRecipientRescueFunctions` panics before checking source. Correct the size and reconcile the enumerated files with the 34-file production inventory. Even when repaired, searching for three rescue-function spellings cannot prove the full no-arbitrary-routing invariant. This is a confirmed evidence/control defect, not proof of an asset-routing exploit.
2. **Wrong expected error encoding (eight failures):** two `RobotMoneyVaultTest` tests expect an extra adapter-index word in `AdapterAlreadyActive(address)` revert data. They are inherited into three historical review suites, multiplying two defects into eight failures. Source: `RobotMoneyVaultOps.addAdapter` emits one argument. These failures require test corrections, not a conclusion that duplicate protection is absent.
3. **Unsupported legacy test names (four failures):** both ERC-4626 conformance suites inherit `testFail_redeem` and `testFail_withdraw`, which Forge 1.8.3 refuses to execute. Record this as a tool/suite compatibility gap; do not credit those conformance cases as passing.
4. **Missing local fork (one setup failure):** `WithdrawalsNeverFrozenTest` attempts `http://127.0.0.1:8545`, which refused connection. The promised production-topology withdrawal proof did not run locally. Other fork suites account for skipped evidence as recorded above.

### Static-analysis triage

Slither reported 3 High, 58 Medium, 106 Low, and 62 Informational alerts. The three High `uninitialized-state` alerts name `BasketVault.assets`, `RobotMoneyVault.adapters`, and `ExclusionLedger._checkpoints`. Source inspection shows mutation through storage aliases/linked libraries for the first two and `_checkpoints[account].push(...)` for the third. These particular alerts are false positives for never-initialized state; they do not establish that every use of those collections is safe. The remaining 226 alerts need recorded individual or justified grouped dispositions. A successful analysis is not a clean scan.

## Coverage and closeout requirements

The audit cannot be called comprehensive from chapter presence, test counts, or prior `fixed` labels. The following remain explicit completion requirements:

- Finish a function-by-function assessment of all 34 production Solidity files and the supporting interfaces, scripts, inherited entrypoints, linked libraries, callbacks, and asset/role flows. Inventory is not assessment.
- Map every stable invariant to its exact implementation, exercised assertion, counterexample, and assumptions. `_assertHolds` registry checks are metadata checks; no behavior proof follows from their success. Reopen the INV-1/LIFE-6 evidence claims discussed above.
- Revalidate all contract-relevant historical findings, including FS-RTR-2 and each claimed fix from the October 15 dirty-tree report. Missing tools or changed source invalidate inherited closure assumptions.
- Repair/resolve baseline test failures, run skipped fork/Safe/timelock scenarios against a pinned configuration, and triage all static alerts. Do not silently suppress failures or convert unexecuted tests into passes.
- Reproduce V3 pool mismatch, mutate namespace slots, assess recorder sampling economics with actual ring/cadence/depth/caps, and exercise exclusion recovery under adverse venue states and zero supply.
- Verify chain-specific code, implementations/libraries, roles, Safe threshold/modules, timelock delay, quarantine control, pool identity, caps, and oracle parameters. Pin block numbers and manifests.
- Re-review fixes against their counterexamples. A risk acceptance must name its assumptions and affected users; it is different from a fixed defect or a disproven report.

No historical ledger row is silently changed by this pass. Confirmed behavior, disputed dispositions, and unresolved evidence are separated above so subsequent remediation can update the ledger without erasing the audit trail.
