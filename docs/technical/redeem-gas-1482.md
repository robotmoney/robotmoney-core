# Redeem out-of-gas at the node estimate (core 1482)

## Status
Mechanism not confirmed on a chain. Mitigation is in the contract. No fork run was done in this pass.

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

## Tests
`contracts/test/RobotMoneyVaultRedeemGas.t.sol`: unit suite (floor revert, gas sweep never opaque, bisect-estimate then execute) and a fork suite (skipped without FORK_RPC_URL).

## Client buffer
rmpc takes `--gas-limit` from the operator and does not call `eth_estimateGas`. Its withdraw path goes through the gateway, so no buffer was added. The dapp guard is not built in this pass.

## Open
- Confirm the mechanism with a fork trace.
- Router paths and the gateway are not covered by the guard beyond the vault calls they make.
- The "fails against the unfixed contract" criterion needs a fork run.
