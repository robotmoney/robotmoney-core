# ADR-0020: An in-place upgrade that changes what old state means runs a one-time migration in the upgrade call

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Product owner
- **Extends:** [ADR-0014](ADR-0014-governed-uups-upgrades-and-freeze.md) (the upgrade authority, `upgradeToAndCall`, the freeze). Nothing there is superseded.
- **Related:**
  - `docs/technical/v0.9.0-in-place-upgrade-audit.md` (the audit: storage diff, legacy state, 13 hazards)
  - `docs/technical/contract-upgradeability-plan.md` ("In-place upgrades: migration, layout gate, simulation, Twin"), `docs/technical/security-model.md` (the storage and upgrade rows), `docs/architecture.md` (proxy invariant)
  - [ADR-0019](ADR-0019-fund-swap-adapters-governed-uups-proxies.md) (the adapter swap of the same release), [ADR-0013](ADR-0013-twin-devnet-over-base-sepolia-for-testnet-verification.md) (the Twin)
  - `docs/runbooks/contract-qa/releases/v0.9.0-onevault-upgrade.yaml` (the Deploy 4 in-place upgrade), `docs/operations/contract-release-runbooks.md` 4.12

## Context

Contracts 0.9.0 were written and tested for fresh deployments. Deploy 4 on Base runs contracts 0.8.0 (commit `fa7c47182`) behind governed proxies, and the v0.9.0 release upgrades it in place.

The first Twin rehearsal upgraded the fund and the queue with `upgradeToAndCall(newImplementation, "")`. The new code then ran on state the old code wrote:

- Every field 0.9.0 added read 0. `initialize` writes those fields on a fresh deployment and never runs on an upgraded proxy.
- Three structs had changed in the middle: `Request` and `Settlement` in the queue, `StepParams` in the Rebalancer. Legacy entries decoded as garbage.

The rehearsal showed two failures. The first request made after the upgrade was orphaned from every round (the wind-down era, fixed in commit `0dff21438`). Legacy deposit claims reverted with `Panic(0x11)`: 0.9.0 subtracts a delivered claim from `ownerHeldShares`, which 0.8.0 never wrote.

The storage layout gate had passed. It compared top-level storage rows and listed a namespace's mapping as one flat source line, so it never compared the members of a struct behind a mapping.

The audit of 2026-11-20 found 13 hazards. Owner, 2026-11-20: fix everything in this release, including upgrading the Rebalancer in place and replacing the exclusion ledger.

## Decision

1. **An in-place upgrade ships a one-time migration when the new code adds state that old entries need, or changes a struct reachable from storage.** The migration is the data of `upgradeToAndCall`, so the new code never runs on unmigrated state. It is gated as OpenZeppelin's `reinitializer(n)` gates it (it runs once per proxy), and it reverts `NotUpgradeTimelock` for any caller but the proxy's `upgradeTimelock()`. It checks its own preconditions and reverts on state it cannot migrate. An upgrade that needs no migration still passes empty data.

2. **The v0.9.0 migrations** (commit `588a68598`). Each is `migrateV090` on the proxy, version 2.
   - `Rebalancer.migrateV090()` reads the `_stepParams` slot in the 0.8.0 layout and stores the same values in the 0.9.0 layout, without `keeperGrace`. It reverts `StepParamOutOfBounds` when the decoded values are outside the hard bounds. It calls nothing, so it can run before the fund is upgraded.
   - `RobotMoneyFund.migrateV090(rebalancer)` (`contracts/lib/FundMigrateLib.sol`) writes the five parameters a fresh fund gets from `initialize`: `minPoolDepthUsdc` 2,000,000 USDC, `feeMarginBps` 20, `delistBandBps` 300, `delistBudgetBps` 300, `maxBasketBps` 10000. It replaces the fund's exclusion ledger with a new `FundExclusionLedger` and reverts `OldLedgerNotEmpty` unless the old ledger has no record and holds no recovery USDC. It writes `fund.rebalancer`, and reverts `NotTheRebalancer` or `RebalancerNotUpgraded` unless that address holds `REBALANCER_ROLE` and answers `lastBasketStepAt()`.
   - `FlowQueue.migrateV090(cancelBuffer, maxPause, matchBandBps)` (`contracts/lib/FlowMigrateLib.sol`) requires no pending deposit USDC, no escrowed redemption shares, an empty `activeEpochs` and wind-down era 0. It rewrites every request and settlement from the 0.8.0 layout into the 0.9.0 layout and reverts on an entry that is not in the 0.8.0 layout, on an open legacy request, and on a live freeze with in-kind returns allowed. It adds every undelivered deposit share to its owner's `ownerHeldShares` and requires the sum to equal `totalHeldShares`. It writes the three new `FlowParams` members inside their own bounds, sets `oldestEpoch` to 0 and deletes the walk cursors.
   - **Order on chain: Rebalancer, fund, queue, all before any settlement.** The fund migration requires an upgraded Rebalancer. The queue calls `lastBasketStepAt()` on the recorded Rebalancer at the first settlement of every round. The release chains the three timelock operations by predecessor.

3. **The storage layout gate compares struct members against a release baseline.** `scripts/ci/check-core-storage-layout.sh` expands every struct reachable from a proxied contract's storage, through mappings, arrays and nested structs (`scripts/ci/storage_layout_nested.py`, namespaces read through `contracts/test/helpers/StorageLayoutProbe.sol`). Against a baseline a struct may only gain members at its end. The baseline of a live deployment is a committed directory, `contracts/test/fixtures/storage-layout/baselines/v0.8.0/` for Deploy 4. A mid-struct change passes only when `scripts/ci/storage-layout-migrations.json` names the contract, the struct, both layout hashes and the migration function. With `--require-migrations`, which CI passes, that function must exist in the contract's ABI.

4. **An upgrade is rehearsed on a Twin fork that holds the real pre-upgrade state.** The Twin forks Base at a pin, so the proxies carry the state the live build wrote. On the Twin (chain 918453) nothing before the fork pin is read: the Twin proves what the release changes, and the full-history checks belong to the 8453 run (`docs/runbooks/contract-qa/README.md`, commit `7d57d35e5`).

5. **Before anything is scheduled, the real upgrade chain is simulated from the timelock.** `scripts/runbook/simulate-upgrades.ts` calls each `upgradeToAndCall(newImplementation, migration data)` as the timelock, by `eth_call`, against the deployed implementations, in the on-chain order. The migrations' own requires decide. A revert stops the run with the decoded error before a signer signs.

6. **The v0.10.0 migrations** (issue 2062, owner decision 2026-11-24 on release issue 2061: every one-vault proxy runs a one-time migration where it fits). Each is `migrateV0100()` on the proxy, `reinitializer(3)`, callable only by `upgradeTimelock()`. No 0.10.0 struct changed in the middle, so none rewrites an entry. Each checks the 0.9.0 state the new code relies on, writes only fields a fresh 0.10.0 deployment would hold, and moves no funds.
   - `FlowQueue.migrateV0100()` (`FlowMigrateLib.migrateV0100`): reverts `NotMigratedV090` unless `cancelBuffer`, `maxPause` and `matchBandBps` are non-zero, and `EnrollmentInProgress` unless `enrollPos` is 0. It gives each live deposit bucket of the current cycle that holds basis its hold mark (`depBucketMaxMinHold = maxDepositMinHold`), the hold the 0.10.0 match already falls back to, so no hold changes.
   - `Rebalancer.migrateV0100()`: reverts `StepParamOutOfBounds` unless the stored step parameters are inside the hard bounds.
   - `RebalanceGovernance.migrateV0100()`: reverts `ZeroAddress` without a fund or receipt register and `RoleHasNoHolder` unless `ADMIN_ROLE` and `TARGET_SETTER_ROLE` each have a holder (the new last-holder floor, AGY-08).
   - `ConsensusRecommendationReceipt.migrateV0100()`: reverts `RoleWiringBroken` unless `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE` have holders and `ADMIN_ROLE` administers the submitter and releaser roles.
   - `UniswapV3ExactOutSwapAdapterUpgradeable.migrateV0100()`: reverts `RouterHasNoFactory` unless the router's `factory()` names a contract (the canonical pool check, AGY-13).
   - **`RobotMoneyFund` has no `migrateV0100`.** It has 17 bytes left under EIP-170 (24,559 of 24,576), less than any gated entry point costs (the 0.9.0 gate alone was 191 bytes as a modifier). Its upgrade carries empty data. A test asserts the selector is absent.
   - **Order on chain: Rebalancer, fund (empty data), queue, governance, receipt, swap adapter.** None calls another contract but the adapter's read of its router, so the order is the 0.9.0 one with the three new legs after it. `simulate-upgrades.ts` takes them as `--governance`, `--receipt` and `--adapter` legs.
   - Tests: `UpgradeMigration.t.sol::UpgradeMigrationV0100Test` on synthetic 0.9.0 state, and `UpgradeMigrationV0100Fork.t.sol` on Deploy 4's real state on the Twin fork (suite-05 job `forge-upgrade-fork`). The storage gate also extends the `contracts-0.9.0` tag.

## Consequences

- The fund applies the reinitializer gate inside `FundMigrateLib`, not as a modifier on `RobotMoneyFund.migrateV090`. The modifier costs 191 bytes and the fund had 382 left under EIP-170. The library writes the same `Initializable` slot and uses the same error (`InvalidInitialization`) and event (`Initialized(2)`) as OpenZeppelin's modifier. The gate is hand-written, so it is review surface that the queue and the Rebalancer do not have.
- The upgrade tests (`contracts/test/prototype/UpgradeMigration.t.sol`) use synthetic 0.8.0-shaped state, written with `vm.store` onto a fresh 0.9.0 deployment, because trunk holds no 0.8.0 code. The Twin run is the test against real state.
- The fund's pool-depth guard and fee margin switch on at the fresh-deployment defaults. The migration does not check the live pools against `minPoolDepthUsdc`.
- The queue migration loops over every request, settlement and claim in one transaction. Deploy 4 has 6, 3 and 5. A queue with a long history would need a bounded design.
- The old exclusion ledger is left on chain with no reader. It was empty, which the migration requires.
- The simulation overrides the Rebalancer proxy's implementation slot for the fund leg, because one `eth_call` cannot carry the earlier upgrade's effect. It proves each leg, not the three as one transaction sequence. The Twin run proves the sequence.
- The release tooling accepts only a proxy's own `migrateV090` as non-empty fund upgrade data, records the decoded migration, and the verifier reads `fund.rebalancer()`, the new ledger and the Rebalancer's step parameters (commit `a2075f3f6`). The verifier is the single post-state check.
- A rollback after a migration is not assumed safe: the 0.8.0 code cannot read the migrated structs (runbook 4.12).
- Audit hazard 12 is closed in code (safety review 0.9.0, AGY-11). A delisting before the first 0.9.0 settlement no longer trips the share-price breaker: Check 6 keeps an in-sale asset on both sides when no value was recorded for it (`_breakerValues` in `contracts/lib/FlowCheckLib.sol`: `if (lastVal == 0 && priced) continue;`), and `_recordReferences` in `contracts/lib/FlowSettleLib.sol` clears the record of a slot it could not price. The rule to settle once first is no longer needed. The test is `SafetyReview090.t.sol::test_AGY11_delistBeforeFirstRecordedValueDoesNotTripCheck6`, on synthetic state.

Still open:

- A recorded real-state upgrade test in CI for 0.9.0. For 0.10.0 it exists (`UpgradeMigrationV0100Fork`); it needs updating once 0.10.0 is live, when it proves only the second-call revert.
- The keeper self-test flake (issue 2045).
- The verifier's log-scan backoff (issue 2044). Commit `7d57d35e5` implemented the window and retry options for chains other than the Twin. The issue is still open.
