# LANE 2 — Vault family / custody / share accounting / ERC-4626 / redemption

- Review: `review-security` (adversarial), single-lane slice of the release-0.9.0 review
- Repository: `git@github.com:robotmoney/robotmoney-core.git`
- Branch under review: `release-0.9.0`; work branch `review/security-release-0.9.0-20261117`
- Pinned commit reviewed: `d4a43e6d21efed208816698d2b32f0decea45451` (local HEAD; origin `ffc5e4b0d`, 2 commits behind — local head is authoritative per the review pin)
- `reviewed_at`: `2026-11-17` (UTC)
- Tracker backend: `github` — adhoc review, no issue or PR
- Scope: `contracts/RobotMoneyVault.sol`, `contracts/vaults/*.sol`, `contracts/lib/RobotMoneyVaultOps.sol`, `contracts/lib/ForeignTokenQuarantine.sol`, `contracts/lib/BasketSwaps.sol`, `contracts/lib/BasketAssetConfigGuard.sol`, `contracts/lib/BasketViews.sol`, `contracts/ExclusionLedger.sol`, `contracts/interfaces/IVault.sol`, `contracts/interfaces/IStrategyAdapter.sol`, `contracts/interfaces/IExposureCappedAdapter.sol`, plus the named vault/invariant/fork test files and the CI wiring that executes them.
- Method: map assets / state / trust boundaries, enumerate authority transitions, trace cross-seam flows, adversarially refute each candidate (default = refuted), verify executed-in-CI evidence, and run n-order composition checks.

## Verdict

**No findings survived refutation.** Zero `FINDING L2-NN` entries are reported. Every candidate below was traced to observed code, documentation, and CI evidence that refutes the hypothesized defect, so none meets the "found defect with observed evidence" bar. Prior-review lane findings (`review-security-019/020/021/022/024/025/026/027/028`, and the SR-1012 baseline 1–6/8) are recorded as fixed at this commit and are **not** re-reported.

Finding structure used (template, intentionally unused this run): `FINDING L2-NN` with `title`, `classification`, `severity` (critical/high/medium/low/info; found defects cap at high), `confidence`, `requirement`, `evidence` (repository-relative `path:line`), `impact`, `recommendation`, `owner`, `related_findings`.

## Refuted candidate hypotheses (not findings)

Each was driven to a concrete refutation with `path:line` evidence.

1. **Share-inflation / donation / first-depositor attack.** Refuted. Both families use `_decimalsOffset() = 18` with 6-decimal shares (`contracts/RobotMoneyVault.sol:502-528`, `contracts/vaults/BasketVault.sol:513-518`), giving OZ virtual shares `10^18` / virtual assets `1`; `previewDeposit`/`convertToShares` use `+1` denominators (`contracts/RobotMoneyVault.sol:584-585`). Cost of a donation attack scales ~`10^18`. Prior info-level `FS-VLT-27` raw-share display quirk is documented, not a defect.

2. **Exit-fee underflow / fee socialized onto holders.** Refuted. `fee = grossAssets - assets` where `previewRedeem` nets the fee (`contracts/RobotMoneyVault.sol:655-658,732-739`) and `previewWithdraw` grosses it up with Ceil (`:662-665`), so `grossAssets >= assets` in both paths. `_pullProportional` clamps realised proceeds to `grossAssets` and `_withdraw` asserts `realizedGross >= grossAssets`; the fee is charged only on proceeds actually sourced (`:773-819,845-871`). BasketVault charges the fee on realised swap proceeds, not a share-implied mark (`contracts/vaults/BasketVault.sol:904-933`).

3. **`withdraw(maxWithdraw(owner))` reverts with non-zero exit fee.** Refuted. `maxWithdraw` uses Floor on the gross→net conversion (`contracts/RobotMoneyVault.sol:674-678`); `_netToGross(...Ceil)` of that value is `<= _convertToAssets(balance, Floor)`, and `_convertToShares(..., Ceil)` of it is `<= balance`, so the ERC-4626 max-withdraw "MUST NOT revert" rule holds. Asserted directly in `contracts/test/ERC4626PreconditionChecks.t.sol:77-150`.

4. **`_allocate` balance-delta underflow on a refusing venue.** Refuted. `handedBack = balanceOf(this) + amount - before` with `balanceOf(this) = before - amount + H` gives exactly `H >= 0`, so the subtraction cannot underflow; `handedBack >= amount` returns 0 and excess stays idle NAV (`contracts/lib/RobotMoneyVaultOps.sol:910-924`). A refusing supply hands USDC back and stays counted in NAV (`DeployRefused`), consistent with prior finding 025's fix.

5. **`pullFromAdapters` shortfall / silent under-pay.** Refuted. Total reported balance is checked before pulling (`:421-432`); under-delivery reverts `InsufficientAdapterLiquidity` (`:463-466`); real adapters additionally revert `WithdrawShortfall`. Documented in `docs/technical/redeem-gas-1482.md:9,128-131`.

6. **BasketVault `redeem` pays less than `previewRedeem`.** Refuted (bounded). `previewRedeem` is a TWAP×slippage×fee floor (`contracts/vaults/BasketVault.sol:799-805`); each swap enforces `amountOutMinimum = TWAP(sellAmount-1)×(1-maxSlippage)` (`:956-973`), so realised gross is at least the floor before the fee. The one-unit / dust-leg residual is documented and bounded to sub-1-USDC-unit per skipped leg (core 1778, QA plan D6; `docs/technical/redeem-gas-1482.md:97-126`). No observable material shortfall.

7. **Deposit-side value leak / round-trip farming (SUP-3/F-16).** Refuted. BasketVault discards OZ's pre-computed shares and mints on the realised post-swap NAV delta with a `DepositBelowSlippageFloor` guard (`contracts/vaults/BasketVault.sol:595-667`); `previewDeposit` discounts twice (entry and exit) so `previewRedeem(previewDeposit(x)) <= x` (`:570-587,826-852`). ORA-4 `NavMarketDeviationExceeded` blocks entry outside the band (`:614-621`).

8. **Quarantine bypass / arbitrary admin routing (INV-1).** Refuted. `RobotMoneyVault.sweepForeignToken` protects the asset and share token and sends only to the governed `quarantineAddress` (`contracts/RobotMoneyVault.sol:1294-1324`); `BasketVault.sweepForeignToken` additionally protects every active *and* configured-inactive basket asset (`contracts/vaults/BasketVault.sol:1360-1390`); the two `ForeignTokenQuarantine.sweep` overloads hardcode or read governed destinations, never `msg.sender` (`contracts/lib/ForeignTokenQuarantine.sol:75-101`). `ExclusionLedger.sweepForeignToken` protects USDC and the vault share token (`contracts/ExclusionLedger.sol:339-349`).

9. **Exclusion-recovery custody defect (re-report of prior 021/022/026).** Refuted at HEAD. Recovery is routed to the ledger, never idle NAV (`contracts/ExclusionLedger.sol:217-239`); `emergencyExcludeAdapter` gives EMERGENCY an exclude-only lever; force-removal of a funded entry opens a ledger record and re-add drains into it first (`contracts/lib/RobotMoneyVaultOps.sol:471-482`, `ExclusionLedger.sol:54-63`). Lazy checkpoints follow the OZ v4 `ERC20Snapshot` "write balance before change" pattern and binary-search `balanceAt` (`:241-250,353-361,286-313`). `claim` always pays the holder, never the caller (`:254-268`).

10. **Deactivated basket asset strands a reappearing balance (re-report of audit L-15).** Refuted. `deactivateAsset` keeps the token in storage (only sets `active=false`), so `sweepForeignToken` still protects it and `reabsorbRemovedAsset` permissionlessly reabsorbs it into NAV via a TWAP-bounded swap or quarantines it on a degraded pool (`contracts/lib/BasketAssetConfigGuard.sol:227-242`, `contracts/vaults/BasketVault.sol:1168-1211`).

11. **In-kind payout underpayment / reentrancy.** Refuted. `redeemInKind` burns first, uses the pre-burn `supplyBefore`, and is `nonReentrant`; `_payLeg` floors each leg and pays the exit fee to `feeRecipient` (`contracts/vaults/BasketVault.sol:755-770`, `contracts/lib/BasketAssetConfigGuard.sol:271-308`).

12. **Redeem gas-floor liveness failure.** Refuted for the pinned scope. Entry floors bind before state-dependent work: vault `PULL_ENTRY_GAS_FLOOR`/`DEPOSIT_ENTRY_GAS_FLOOR = 1_600_000`, mid-path 400k/150k (`contracts/RobotMoneyVault.sol:420-428,577-596,749-770`; `docs/technical/redeem-gas-1482.md:37-74`); BasketVault `300_000 + assets.length * 400_000` (`contracts/vaults/BasketVault.sol:378-385,735-746`). Fork regression tests execute estimate-then-include in the costlier state in CI. Documented residual (long-term headroom if pool/adapter gas grows) is a "not proven" item, not a current defect (`:154-159`).

13. **UUPS storage-layout drift.** Refuted. CI diffs AST-id-free (label, slot, offset, type) of every state variable and storage-struct member, linked libraries, and ERC-7201 namespaces against committed snapshots, the PR base, and every released layout, with a self-test that fails on mutated snapshots (`.github/workflows/suite-01-02-forge-tests.yml:215-249,251-264`). No migration drift observed at this commit.

## N-order composition check (required)

Three interacting controls were composed rather than reviewed in isolation:

- **Lifecycle × redemption liveness.** `retire()` (registry-only), `pauseDeposits()` (EMERGENCY), and `shutdownVault()` (EMERGENCY) gate only the deposit side (`RobotMoneyVault.sol:691-722,1075-1084,1194-1245`; `BasketVault.sol:1253-1289,1332-1358`). `redeem`/`redeemInKind` carry no such gate; the single narrow exception (`ZeroPayoutDuringExclusion`, `RobotMoneyVault.sol:787-791`) fires only when NAV is 0 *and* an exclusion is open, and recovery is independently claimable through `ExclusionLedger.claim`. Withdrawals are therefore reachable across the full composed lifecycle, matching `contracts/test/WithdrawalsNeverFrozen.t.sol` (executed in the fork-regressions job, workflow `:592-600`). No freeze.
- **Vault share rounding × router redeem floor.** BasketVault overrides `redeem` to return the *actual* `_lastWithdrawnAssets` rather than OZ's pre-computed `previewRedeem`, so the router's per-leg `minAssetsPerLeg` guard compares against real proceeds (`contracts/vaults/BasketVault.sol:719-746,925-929`). Without this composition the guard would be inert. Consistent, no short-pay.
- **Fee math × TVL cap × maxWithdraw.** The 18-offset share denominator, the Floor `maxWithdraw`, and the Ceil `_netToGross` compose so `withdraw(maxWithdraw(owner))` neither underflows the fee nor reverts the cap path (evidence in refutations 2–3). Consistent.

## Clean areas

- **Share accounting / inflation resistance:** virtual-share offset on both families; single-NAV-read deposit path (`RobotMoneyVault.sol:577-588`); realised-delta mint on BasketVault.
- **ERC-4626 preview/execute parity:** `previewRedeem` = actual on RobotMoneyVault; BasketVault's `previewRedeem` is a documented lower bound and `previewWithdraw` reverts `RedeemOnly` by design (documented deviation at `contracts/vaults/BasketVault.sol:884-890`), not a defect.
- **Fee handling:** exit fee charged only on realised proceeds; bounded to `MAX_EXIT_FEE_BPS`; fee recipient and fee view updates are ADMIN-only.
- **Custody invariants INV-1/INV-2/INV-3:** no arbitrary admin routing, permissionless governed quarantine, and forced USDC donations absorbed into NAV rather than stranded.
- **Exclusion ledger:** snapshot claims, permissionless claims that always pay the holder, no expiry, surplus returned to NAV.
- **Oracle guards:** ORA-3 execution-pool==TWAP-pool equality, ORA-4 NAV/market deviation gate, V4 sell anchor, codehash allowlist for basket swap adapters (`BasketAssetConfigGuard.sol:163-265`, `BasketViews.sol:133-217`).
- **Liveness:** deposits-only pause, separate retirement flag, last-admin floor, gas floors with fork-tested margins.
- **Upgrade safety:** governed UUPS with timelock authority, one-way freeze, and CI storage-layout gates anchored to release tags.
- **CI execution honesty:** unit (`suite-01-02-forge-tests.yml:148-161`), invariant/fuzz (`:427-442`), and fork (`:555-612`) jobs all run with executed-test-count guards; fork tests skip only when `FORK_RPC_URL` is absent and the runner fails a run in which nothing executed (`:521-524`).

## checked_shapes

- `optional-fixture-early-return` — checked: fork tests skip only with a named reason when the RPC is absent; `.github/scripts/forge-fork-tests.ts` and `.github/scripts/forge_test_require_executed.sh` turn a zero-execution run red, so the skip cannot masquerade as a green vault guarantee.
- `uninvoked-evidence-script` / `missing-evidence-script` — checked: every named vault test file (VaultFamilyInvariants, ERC4626PreconditionChecks, CustodyInvariant, RetireVaultBatch, WithdrawalsNeverFrozen, redeem-gas suites) is invoked by a CI step with a non-zero executed-count floor.
- `digest-blind-to-attribute` — checked: the storage-layout gate compares per-variable label/slot/offset/type, not a single digest, so a layout attribute drift cannot pass while the digest stays green.
- `trigger-scoped-dead-code` — checked: fork-only liveness tests (WithdrawalsNeverFrozen, FourVaultInitialState) run in the ready-for-review `fork-regressions` job and are not relied on at draft time.
- `fixture-shape-blind-selftest` — checked for the storage-layout and coverage guards, which ship mutation/negative self-tests that fail on planted drift.
- Loud `vm.skip` in `contracts/test/fv/FvInvariants.t.sol` — checked: RED invariant stubs carry a reason and remediation issue number; they are expected-fail placeholders, not silent skips masking a HOLDS invariant.

## Limitations

- Static review at the pinned commit only; no `forge test`, fork, or on-chain transaction was executed by this reviewer — execution evidence was assessed by reading CI wiring and test sources.
- No `FORK_RPC_URL` was available; fork-dependent claims (gas-floor headroom, live pool behaviour, real Safe/timelock paths) are taken from the repository's documented fork runs and CI, not independently reproduced here.
- The 426 KB `20261015-review-security-claude.md` and its JSON were grepped for lane finding IDs and status, not read in full; prior-finding "fixed" status is taken from those records plus confirmed code at HEAD.
- Origin is 2 commits behind local HEAD; per the review pin, local `d4a43e6d2` is authoritative and origin-only changes were not reviewed.
- Gas-floor margins, TWAP-window headroom, and thin-pool behaviour are documented as "not proven" under future conditions; they are clean at this commit but must be re-measured when adapters, venues, or asset lists change.
