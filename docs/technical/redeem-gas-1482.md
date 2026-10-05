# Redeem out-of-gas at the node estimate (core 1482)

## Status
Root cause: PROVEN on a Base mainnet fork (read-only RPC, in-process, no transaction sent). See "Proven root cause" below. The earlier "state drift between estimate and inclusion" hypothesis is confirmed, and the first guard (PR 1505) is shown not to fix it.
- Silent under-provisioning inside the vault: DISPROVEN. No code on the redeem path swallows a failed adapter call, so low gas can only revert, never succeed with a short payout.
- Guard limit: PROVEN. The guard is a floor, not a proof. An adapter whose worst-case withdraw needs more than about 385k gas fails with an untyped revert in a window of gas limits just above the guard.

## Proven root cause
A redeem costs more gas in the first block after the protocols last accrued interest than in a block where they already accrued. `eth_estimateGas` returns the smallest limit that passes in the state it runs in, with no slack. If that state is cheaper than the state at inclusion, the transaction runs out of gas inside a nested call.

Measured on a Base fork (real Aave V3, Compound V3 and Moonwell Flagship adapters deployed through `DeployVault`, 5,000 USDC deposited, redeem of 10 percent of the shares), test `test_rootCause_accrualAddsGasInLaterBlock`:

| State | Redeem gas |
|---|---|
| Protocols accrued in this block (same timestamp) | 1,010,606 to 1,013,914 (varies a little with the fork block) |
| First redeem 2 s or more later (accrual runs) | 1,106,952 to 1,107,018 |
| Accrual delta | about 93,000 to 96,000 |

The live failure (gas limit 1,010,991, gas used 1,005,925) matches the accrued-this-block cost to within 0.5 percent. The estimate was taken in a state where the accrual was already paid. The mined block paid for it and ran out.

Per adapter withdraw gas in the later-block state (test `test_rootCause_realAdapterWithdrawGas_laterBlock`, a one third pull): Aave 183,131, Compound 150,586, Moonwell (MetaMorpho) 345,521. The 400k per-adapter floor holds with 54k to spare on the heaviest adapter.

Reproduction against a vault with every gas floor set to zero (the unfixed behaviour, run locally by editing the three constants, not committed): estimate in the accrued state 988,786. Executed one block later at exactly that limit the call fails with empty revert data. The trace shows `OutOfGas` inside `AaveV3Adapter.withdraw -> pool.withdraw -> aToken.burn -> USDC.transfer`, bubbled up as an empty `Revert`. That is a status 0 with no reason, the reported symptom. It is state dependent, which is why it hit about 1 run in 8.

PR 1505 as first merged did not fix it. With its floors (1.2M entry on the override, a second 1.2M check inside `_pullProportional`, 400k per adapter) the estimate was 1,585,944 in the accrued state. One block later the same limit reverts `InsufficientGas` (68 bytes of typed data). The failure is typed now, but the transaction still fails at the node estimate. Reason: the inner entry check sits after about 386k of reads, so the estimate is that check's threshold, and the threshold moves with the state. Any floor that binds mid-path has this property. After the inner check was removed, the 400k floor before the last adapter bound instead (estimate 1,316,289, same typed failure one block later).

## Fix that the proof demands
The entry floor on `redeem` and `withdraw` must be the binding floor, set above both the worst real need and the worst mid-path threshold, so the estimate sits at the floor in every state.
- Removed the second `PULL_ENTRY_GAS_FLOOR` check inside `_pullProportional` (redundant, and state dependent).
- `PULL_ENTRY_GAS_FLOOR` 1_200_000 to 1_600_000. The last adapter floor binds at about 1.32M in the accrued state and about 1.41M one block later, so 1.6M dominates it by about 190k.
- Router leg floor 1_250_000 to 1_650_000. Gateway withdraw floor 1_300_000 to 1_700_000 (they must hand the vault 1.6M after the 63/64 forward).
- Result on the fork: the estimate is 1,600,497 in the accrued state. Executed 2 s, 1 hour and 1 day later at exactly that limit it succeeds (test `test_rootCause_estimateThenIncludeNextBlock`). A limit at the accrued-state cost reverts typed (test `test_rootCause_limitAtSameBlockCostRevertsTyped`).
- Cost to users: the estimate rises from about 1.01M to 1.6M. Gas used is unchanged. Only the limit a wallet sets is higher (a wallet pays for used gas, not for the limit).

## What was ruled out
- No try/catch on the happy path. `_pullProportional` calls `adpt.withdraw` directly. The try/catch calls exist only in `emergencyWithdrawAll`, `emergencyWithdrawAdapter` and `forceRemoveAdapter` (out of scope by the issue).
- `AaveV3Adapter`, `MorphoAdapter` and `CompoundV3Adapter` `withdraw` have no gas-dependent branches of their own.

## Working hypothesis
The redeem path is long and read heavy. `previewRedeem` reads each adapter `totalAssets()` (MetaMorpho about 201k gas each), then `_pullProportional` reads them twice more and calls each adapter `withdraw`. Total gas was about 1.006M against an estimate of 1.011M. A callee inside the protocol call chain behaves differently as the forwarded gas changes (the 63/64 rule, cold versus warm access, or an inner call that tolerates failure). `eth_estimateGas` bisects on a state where it passes, and the mined block differs by a few thousand gas. Confirm with a fork trace (`cast run --trace`) of a failing run.

## Fix (contracts/RobotMoneyVault.sol)
- `InsufficientGas(available, required)` custom error.
- `redeem` and `withdraw` overrides check `PULL_ENTRY_GAS_FLOOR` (1.6M after the root-cause fix) then call `super`.
- `_pullProportional` checks `ADAPTER_CALL_GAS_FLOOR` (400k) before each adapter withdraw and `TAIL_GAS_FLOOR` (150k) before returning. It no longer checks the entry floor itself (removed in the root-cause fix).
- `_routeDeposit` checks `ADAPTER_CALL_GAS_FLOOR` before `adpt.deploy`.
- Share accounting and fee math are unchanged.

Effect: a call with too little gas reverts with a reason. The node estimate cannot land under the floor. The floors are constants to tune after the fork test measures real usage.

## Mechanism analysis (EIP-150, per external call on the redeem path)
- The vault calls `adpt.totalAssets()` (entry sum), `adpt.totalAssets()` and `adpt.withdraw(pull)` per adapter in pass 1, and again in pass 2 only for rounding leftovers. Each call forwards `gasleft - floor(gasleft/64)`.
- Per-adapter guard: `gasleft() >= 400_000` before `withdraw`, so the adapter is entered with at least 400_000 * 63/64 = 393_750 gas. Measured with a probe adapter on the real vault: minimum entry gas 393_154 (call-site overhead about 600).
- The adapter then forwards 63/64 again to its own inner call (`MORPHO_VAULT.withdraw`, Aave `pool.withdraw`, Comet `withdraw`). The inner protocol call therefore gets about 387k at the tightest accepted limit.
- Worst-case cold cost of an adapter withdraw is not known analytically. A cold call to each of the adapter, protocol, token and oracle addresses costs 2_600 gas each and each cold SLOAD 2_100. MetaMorpho walks its withdraw queue, so its cost grows with queue depth and accrual. The 387k figure is the number to beat. Only a fork measurement can settle it.
- Failure landscape with a stub that needs 450k to withdraw (test `test_guardLimit_adapterNeedingMoreThanFloorFailsOpaque`), by rising gas limit: typed `InsufficientGas` (adapter floor), then an untyped window about 114k wide (empty data, or `FailedInnerCall` when a token transfer is starved), then typed `InsufficientGas` (tail floor, 150k), then success. A bisect on success (what `eth_estimateGas` does) still lands on the first success. The window matters because a wallet that picks a limit by other means can land in it.
- A callee that tolerates inner failure (stub with a swallowed inner out-of-gas) cannot make the vault under-pay. It returns 0, the vault raises `InsufficientAdapterLiquidity`, and the real adapters also revert `WithdrawShortfall` on a short delivery. Test `test_tolerantAdapter_neverSilentUnderpay` sweeps limits and checks the payout equals `previewRedeem` on every success, and that the bisect estimate pays in full.

## Tests
`contracts/test/RobotMoneyVaultRedeemGasMechanism.t.sol`: three unit tests with a gas-metered probe adapter (63/64 entry gas, tolerant callee never under-pays, guard limit window). Stubs only: the real Aave, Morpho and Compound adapters need a fork.
`contracts/test/RobotMoneyVaultRedeemGas.t.sol`: unit suite (floor revert, gas sweep never opaque, bisect-estimate then execute) and a fork suite (skipped without FORK_RPC_URL).

## Router and gateway guards (core 1482, pass 4)
The same typed `InsufficientGas(available, required)` error now guards every path that fans out to a vault:
- `PortfolioRouter._redeemLeg` (reached by `redeemFor`): `gasleft() >= REDEEM_LEG_GAS_FLOOR` (1_650_000 after the root-cause fix, was 1_250_000) before each `vault.redeem`. The vault's entry floor is 1_600_000 measured after the 63/64 forward, so the router needs about 1_625_000 to hand it that much. The margin is about 25k.
- `RobotMoneyGateway.withdraw`: `gasleft() >= WITHDRAW_GAS_FLOOR` (1_700_000 after the root-cause fix, was 1_300_000) before `sourceVault.redeem`, after the share pull and window writes.
- `RobotMoneyGateway.withdrawFromRouter`: the same floor before `router.redeemFor`.
- The floors are tunable constants, like the vault floors. They have no fork measurement behind them yet.
- Effect on an estimate: the floor is checked after the caller's own cold writes, so `eth_estimateGas` returns the floor plus that spend (the unit tests show about 1_960_000 for the gateway paths after the root-cause fix). A wallet that sets its own limit below the floor gets the typed error, not an opaque revert.

Tests: `contracts/test/RedeemGasGuards.t.sol`. A gas-metered stub vault (`GasMeteredStubVault`) burns 400k gas in `redeem` and records its entry gas. One test per path reverts `InsufficientGas` with the right `required` value below the floor. One estimate-then-execute test per path bisects the smallest passing gas limit (what `eth_estimateGas` does), then executes at exactly that limit and checks full payout and a vault entry gas of at least 1_600_000. The router test also sweeps every limit from 400k to the estimate and checks each one reverts typed, never opaque.

## Proven and not proven
Proven on the fork:
- The root cause above, with the numbers above.
- The estimate-then-include sequence fails against a floor-free vault (empty data) and against the first guard (typed), and passes with the entry-dominant floor over three time gaps.
- Real adapter withdraw cost in the later-block state is below the 400k per-adapter floor.

Proven by unit tests (stubs only):
- The vault, the router and both gateway withdraw paths revert with `InsufficientGas` below their floors.
- At the bisect estimate each path pays in full.
- No redeem path swallows an adapter failure, so low gas cannot produce a short payout.

NOT proven:
- Which protocol accounts for how much of the 93k delta. The adapter calls alone show about 58k (Aave 9k, Compound 8.5k, Moonwell 40k on withdraw). The rest is on the vault read path. A `cast run --trace` of a real failed transaction would split it. Not needed for the fix.
- That 1.6M stays above the worst case on mainnet over time. It leaves about 490k over the measured later-block cost. A deeper MetaMorpho withdraw queue or a longer interest gap on a stale market could add more. Re-measure when adapters change.
- Cold-state variance between a real transaction and the forge in-process run. Forge showed no cold versus warm difference across a state revert, so the figures are the in-process cost.
- The router and gateway estimates against the real adapters on the fork (they are covered by stub tests only).
- Anything on a live chain. No transaction was sent.

Fork command (a read-only Base RPC in `FORK_RPC_URL`; never put a key in a file). CI runs it through the Twin chain in the fork-regressions job:
```
FORK_RPC_URL=https://mainnet.base.org forge test --match-path "contracts/test/{RobotMoneyVaultRedeemGas,RobotMoneyVaultRedeemGasRootCause}.t.sol" --match-contract "ForkTest|RootCauseTest" -vv
```
Tests: `contracts/test/RobotMoneyVaultRedeemGasRootCause.t.sol`.

## Client buffer
Not added. rmpc takes `--gas-limit` from the operator and does not call `eth_estimateGas`. Its withdraw path goes through the gateway. The contract guard is sufficient for the vault's own gaps, and whether it is sufficient for the real adapters depends on the fork measurement below. If that measurement shows a worst-case adapter withdraw above about 385k, the fix is to raise `ADAPTER_CALL_GAS_FLOOR` in the contract (floors are constants), not to add a client buffer.

## Open
- Split the 93k accrual delta by protocol with a trace (optional).
- Router and gateway estimate-then-include on the fork against the real adapters.
- Product-acceptance redeem at the node estimate (devops 63) after this lands.
