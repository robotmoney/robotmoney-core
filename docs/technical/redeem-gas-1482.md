# Redeem out-of-gas at the node estimate (core 1482)

## Status
Split verdict after the unit-level pass (no fork, no real adapters):
- Silent under-provisioning inside the vault: DISPROVEN. No code on the redeem path swallows a failed adapter call, so low gas can only revert, never succeed with a short payout.
- The estimate-lands-low mechanism on the live chain: STILL OPEN. It needs a fork trace of the real MetaMorpho path. The most likely cause is state drift between estimate and inclusion (interest accrual), which the 1.2M entry floor covers by about 19 percent over the 1.006M measured use.
- Guard limit: PROVEN. The guard is a floor, not a proof. An adapter whose worst-case withdraw needs more than about 385k gas fails with an untyped revert in a window of gas limits just above the guard.

## What was ruled out
- No try/catch on the happy path. `_pullProportional` calls `adpt.withdraw` directly. The try/catch calls exist only in `emergencyWithdrawAll`, `emergencyWithdrawAdapter` and `forceRemoveAdapter` (out of scope by the issue).
- `AaveV3Adapter`, `MorphoAdapter` and `CompoundV3Adapter` `withdraw` have no gas-dependent branches of their own.

## Working hypothesis
The redeem path is long and read heavy. `previewRedeem` reads each adapter `totalAssets()` (MetaMorpho about 201k gas each), then `_pullProportional` reads them twice more and calls each adapter `withdraw`. Total gas was about 1.006M against an estimate of 1.011M. A callee inside the protocol call chain behaves differently as the forwarded gas changes (the 63/64 rule, cold versus warm access, or an inner call that tolerates failure). `eth_estimateGas` bisects on a state where it passes, and the mined block differs by a few thousand gas. Confirm with a fork trace (`cast run --trace`) of a failing run.

## Fix (contracts/RobotMoneyVault.sol)
- `InsufficientGas(available, required)` custom error.
- `redeem` and `withdraw` overrides check `PULL_ENTRY_GAS_FLOOR` (1.2M) then call `super`.
- `_pullProportional` checks the entry floor, `ADAPTER_CALL_GAS_FLOOR` (400k) before each adapter withdraw, and `TAIL_GAS_FLOOR` (150k) before returning.
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

## Client buffer
Not added. rmpc takes `--gas-limit` from the operator and does not call `eth_estimateGas`. Its withdraw path goes through the gateway. The contract guard is sufficient for the vault's own gaps, and whether it is sufficient for the real adapters depends on the fork measurement below. If that measurement shows a worst-case adapter withdraw above about 385k, the fix is to raise `ADAPTER_CALL_GAS_FLOOR` in the contract (floors are constants), not to add a client buffer.

## Open
- Fork trace of a failing live run (`cast run --trace`) to confirm or refute state drift as the cause.
- Measure worst-case cold gas of each real adapter `withdraw` on a fork, then set `ADAPTER_CALL_GAS_FLOOR` above it (with 64/63 headroom).
- Router paths and the gateway are not covered by the guard beyond the vault calls they make.
- The "fails against the unfixed contract" criterion needs a fork run.
