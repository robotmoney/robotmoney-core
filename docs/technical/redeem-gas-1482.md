# Redeem out-of-gas at the node estimate (core 1482)

## Status
- Root cause: PROVEN on a Base mainnet fork (read-only RPC, in-process, no transaction sent).
- The first guard (PR 1505) did not fix it. It changed the failure from an empty revert to a typed `InsufficientGas`, but the transaction still failed at the node estimate.
- The fix makes one gas floor bind at each entrypoint, checked before any state-dependent work. Router and gateway floors scale with the number of non-zero legs.
- Silent under-payment inside the vault: DISPROVEN. No code on the redeem path swallows a failed adapter call, so low gas can only revert. It can never succeed with a short payout.

## Proven root cause
A redeem costs more gas in the first block after the venues last accrued interest than in a block where they already accrued. `eth_estimateGas` returns the smallest limit that passes in the state it runs in, with no slack. When that state is the cheaper one, the mined transaction runs out of gas inside a nested call.

All figures come from the Base fork. They use the real Aave V3, Compound V3 and Moonwell Flagship adapters deployed through `DeployVault`, with 5,000 USDC deposited and a redeem of 10 percent of the shares. They move by a few thousand gas with the fork block.

| Measurement | Gas | Test |
|---|---|---|
| Redeem, venues accrued in this block | 961,296 | `test_rootCause_accrualAddsGasInLaterBlock` |
| Redeem, first block 2 s or more later | 1,054,334 | same |
| Accrual delta | 93,038 | same |
| Unfixed vault: estimate in the accrued state | 936,109 | `test_unfixedVault_estimateFailsOneBlockLaterWithEmptyRevert` |
| Unfixed vault: smallest passing limit one block later | 1,029,147 | same |
| Mid-path threshold one block later (entry floor zeroed) | 1,221,698 | `test_midPathThreshold_laterBlock_staysUnderEntryFloor` |
| Margin of that threshold under the 1.6M entry floor | 378,302 | same |
| Adapter withdraw, later block: Aave / Compound / Moonwell | 183,131 / 150,586 / 345,521 | `test_rootCause_realAdapterWithdrawGas_laterBlock` |

Before the pass-1 change below, the redeem cost about 1.011M in the accrued state and 1.107M one block later. The live failure had a limit of 1,010,991 and used 1,005,925 gas. That limit matches the accrued-state cost to within 0.5 percent.

The unfixed vault is the shipped bytecode with every gas-floor immediate set to zero. The test-local `BytecodePatch` harness does this by walking opcodes, then `vm.etch` puts the result on the deployed vault. Storage and immutables are unchanged. Executed one block later at the accrued-state estimate, the call fails with empty revert data. That is a status 0 with no reason, the reported symptom. The trace shows `OutOfGas` along the Aave path: `AaveV3Adapter.withdraw`, then `pool.withdraw`, then `aToken.burn`, then `USDC.transfer`. The failure depends on state, which is why it hit about 1 run in 8.

## Why a mid-path floor does not fix it
The estimate always lands on whichever check binds first. If that check sits after state-dependent work, the threshold moves between estimate and inclusion. These results were measured on the fork:
- **PR 1505 floors.** The checks were 1.2M on the override, a second 1.2M inside `_pullProportional` and 400k per adapter. The estimate was 1,585,944 in the accrued state. One block later the same limit reverts `InsufficientGas`. The inner check sat after about 386k of reads.
- **Inner entry check removed.** The 400k check before the last adapter, or before a pass-2 rounding pull, bound instead. The estimate was 1,316,289, with the same typed failure one block later.
- **Router per-leg floor (review finding).** The router checked `gasleft()` before each leg. Leg 2's check runs after leg 1 has spent accrual-dependent gas. With the old router and gateway, the 2-leg and 3-leg estimate-then-include fork tests fail typed one block later. Router estimates were 2,644,631 for 2 legs and 3,335,802 for 3 legs. Gateway estimates were 3,033,625 and 3,792,465.

## Fix
One floor binds at each entrypoint, checked before any state-dependent work. Each floor is set above the worst real need and above every mid-path threshold. The estimate then sits at the floor in every state.

Vault (`contracts/RobotMoneyVault.sol`):
- **Entry floor:** `redeem` and `withdraw` check `PULL_ENTRY_GAS_FLOOR` = 1,600,000 at entry. The duplicate entry check inside `_pullProportional` is removed.
- **Mid-path floors:** `ADAPTER_CALL_GAS_FLOOR` (400k) before each adapter call and `TAIL_GAS_FLOOR` (150k) stay. They give a typed error to a caller that sets its own limit. They do not bind under the entry floor (378k margin).
- **Pass-1 remainder:** the last counted adapter in pass 1 takes the flooring remainder, still capped at its balance (audit L-2). Pass 2 now runs only when an adapter is short. Before this, pass 2 ran on every fork redeem (4 pulls instead of 3). It added an extra adapter call behind a 400k floor, and that put the mid-path threshold at about 1.41M, a margin of only about 190k. Now it is 1.22M with a 378k margin, and a redeem costs about 53k less. The total pulled is unchanged. Up to a few wei of USDC move from the first adapter with a balance to the last one. Share accounting and fee math are unchanged. The full unit, fuzz and invariant suite passes (1281 tests).

Router (`contracts/PortfolioRouter.sol`):
- **Entry floor:** `redeemFor` checks `legs * REDEEM_GAS_PER_LEG` at entry, where `legs` counts the non-zero `sharesPerLeg` and `REDEEM_GAS_PER_LEG` = 1,700,000.
- **Sizing:** each leg must hand its vault 1.6M after the 63/64 forward, which is about 1,625,400 at the call, plus the leg's registry and allowance reads. A real leg costs about 1.11M, so earlier legs leave slack for later ones.
- **Per-leg check removed:** the check in `_redeemLeg` is gone.

Gateway (`contracts/gateway/RobotMoneyGateway.sol`):
- **`withdraw`:** checks `WITHDRAW_GAS_FLOOR` = 2,000,000 at entry, before the policy reads, window writes, payment id and share pull. The vault needs about 1,625,400 at the call, plus that prefix.
- **`withdrawFromRouter`:** checks `ROUTER_WITHDRAW_BASE_GAS + legs * ROUTER_WITHDRAW_GAS_PER_LEG` (400,000 + legs * 1,850,000) at entry, after the array-length checks. Per leg, the router needs 1.7M after the 63/64 forward (about 1,727,000) plus the gateway's share pull, approvals and custody reads for that leg.
- **Mid-path checks removed:** the checks before `vault.redeem` and `router.redeemFor` are gone.

### Deposit paths
Deposit has the same defect. On the Base fork, with the deposit entry floor removed, a vault deposit estimated in the accrued-this-block state (1,157,832) fails one block later with an empty revert. The smallest passing limit there is 1,198,732, about 41k higher. The same sequence through `router.deposit`, `gateway.depositTo` to the router and `gateway.deposit` also fails on the unfixed contracts, for 1, 2 and 3 legs.

The same fix applies:
- **Vault:** `deposit` and `mint` check `DEPOSIT_ENTRY_GAS_FLOOR` = 1,600,000 at entry. The mid-path 400k check before `adpt.deploy` stays. With the entry floor removed it binds at about 1.20M, so 1.6M leaves about 400k of margin.
- **Router:** `_depositTo` checks `legs * DEPOSIT_GAS_PER_LEG` (1,700,000) at entry, where `legs` is the length of the effective weight vector. Legs that are later skipped still count, so the floor is an upper bound.
- **Gateway:** `deposit` checks `DEPOSIT_GAS_FLOOR` = 2,000,000 at entry. `depositTo` checks the same floor for a vault destination. For the router it checks `ROUTER_DEPOSIT_BASE_GAS + legs * ROUTER_DEPOSIT_GAS_PER_LEG` (400,000 + legs * 1,850,000), with `legs` read from `router.getEffectiveWeights()`. That read costs the same in every state, and it runs before the first vault call.

Fork tests: `test_fork_deposit_estimateThenIncludeLater` in `RobotMoneyVaultRedeemGas.t.sol` (vault, 2 s, 1 h and 1 day) and the `*_deposit_*` and `*_depositTo_*` cases in `RobotMoneyVaultRedeemGasRootCause.t.sol` (router 1, 2 and 3 legs, gateway to router 1 and 3 legs, gateway single vault).

### Effect on estimates and cost
Estimates measured on the fork. Each was executed one block later at exactly that limit, and every run succeeded:

| Path | Legs | Estimate | Gas used one block later |
|---|---|---|---|
| `vault.redeem` | 1 | 1,600,497 | about 1.05M |
| `router.redeemFor` | 1 / 2 / 3 | 1,707,069 / 3,407,261 / 5,107,453 | 1,121,096 / 1,821,905 / 2,522,700 |
| `gateway.withdrawFromRouter` | 1 / 2 / 3 | 2,261,274 / 4,111,460 / 5,961,646 | 1,414,371 / 2,178,284 / 2,942,442 |

The vault redeem was also executed 1 hour and 1 day later at its estimate, and it succeeded. Wallet limits rise, and a 3-leg gateway withdraw estimates near 6M. The fee paid is unchanged, because a transaction pays for the gas it used, not for the limit. rmpc's fixed default gas limit (issue 1512) and the basket vault guards (issue 1513) are tracked separately.

## What was ruled out
- **No try/catch on the happy path.** `_pullProportional` calls `adpt.withdraw` directly. The try/catch calls exist only in `emergencyWithdrawAll`, `emergencyWithdrawAdapter` and `forceRemoveAdapter`, which the issue puts out of scope.
- **No gas-dependent adapter branches.** `AaveV3Adapter`, `MorphoAdapter` and `CompoundV3Adapter` `withdraw` have none of their own.
- **No silent under-payment.** A callee that tolerates inner failure cannot make the vault under-pay. It returns 0, and the vault raises `InsufficientAdapterLiquidity`. The real adapters also revert `WithdrawShortfall` on a short delivery (test `test_tolerantAdapter_neverSilentUnderpay`).

## Mechanism analysis (EIP-150)
- **Forwarding rule:** each external call forwards `gasleft - floor(gasleft/64)`.
- **Per-adapter guard:** `gasleft() >= 400_000` before `withdraw`, so the adapter is entered with at least 393,750 gas. A probe adapter on the real vault measured a minimum entry gas of 393,154 (test `test_forwardedGas_respectsFloorTimes6364`).
- **Floor limit:** the guard is a floor, not a proof. An adapter that needs more than about 385k fails with an untyped revert in a window of limits just above the per-adapter check (test `test_guardLimit_adapterNeedingMoreThanFloorFailsOpaque`). Under the 1.6M entry floor this window is reached only when a mid-path threshold rises above 1.6M. The real adapters measure at most 345,521, against a 1.22M threshold.

## Tests
- **`contracts/test/RobotMoneyVaultRedeemGasRootCause.t.sol`** (fork):
  - `RobotMoneyVaultRedeemGasRootCauseTest` covers the accrual delta, the unfixed-vault reproduction, the mid-path threshold margin, estimate-then-include over 2 s, 1 h and 1 day, the typed revert at the accrued-state cost, and per-adapter withdraw gas.
  - `RobotMoneyRouterRedeemGasRootCauseTest` runs estimate-then-include for 1, 2 and 3 legs through `router.redeemFor` and `gateway.withdrawFromRouter`. It uses the core stage stack plus two more vaults from `DeployVault`.
- **`contracts/test/RedeemGasGuards.t.sol`** (unit, stubs):
  - Typed floors that scale with the non-zero legs, with zero-share legs not counted.
  - Estimate-then-execute.
  - Estimate-then-include one block later with stubs modelled on the fork: a 1.6M typed entry floor, 1.0M of work and 96k of accrual. The router and gateway run 1, 2 and 3 legs. Against the previous router and gateway, the 2-leg and 3-leg cases fail.
- **`contracts/test/RobotMoneyVaultRedeemGasMechanism.t.sol`** and **`contracts/test/RobotMoneyVaultRedeemGas.t.sol`**: the earlier unit and fork suites.

Fork command (a read-only Base RPC in `FORK_RPC_URL`; never put a key in a file):
```
FORK_RPC_URL=https://mainnet.base.org forge test --match-path "contracts/test/{RobotMoneyVaultRedeemGas,RobotMoneyVaultRedeemGasRootCause}.t.sol" --match-contract "ForkTest|RootCauseTest" -vv
```
CI runs the same selection through the Twin chain in the `forge-fork-vault-regressions` job.

## Not proven
- **Delta split:** which venue accounts for how much of the 93k delta. The adapter withdraw calls alone show about 58k (Aave 9k, Compound 8.5k, Moonwell 40k). The rest is on the vault read path. The fix does not need this split.
- **Long-term headroom:** that 1.6M stays above the worst case as conditions change. A deeper MetaMorpho withdraw queue or a longer interest gap on a stale market could raise the cost. Re-run the margin test when adapters or venues change.
- **Cold-state cost:** whether a real cold transaction costs more than the forge in-process run. Forge showed no cold versus warm difference across a state revert.
- **Single-vault gateway path on the fork:** the fork does not run estimate-then-include for `gateway.withdraw`. Only the stub test covers it.
- **Live chain:** nothing ran on a live chain. The product-acceptance redeem at the node estimate (devops 63) is still to run.

## Basket vault redeem (core 1513)
`BasketVault` (rmPROTO, rmAGENT, rmRWA) sells each held asset on Uniswap V3 during `redeem`. The swap cost depends on pool state (oracle observation writes, tick crossings), so the node estimate can differ from the cost at inclusion, as in 1482.

Measured on a Base fork with no guard (test `BasketVaultRedeemGasForkTest`, 1,000 USDC deposited, half the shares redeemed):

| Vault | Estimate in the deposit block | Smallest passing limit one hour later |
|---|---|---|
| rmPROTO (wETH, cbBTC) | 601,119 | 487,773 |
| rmAGENT (same two pools in the test) | 738,126 | 624,780 |
| rmRWA (deSPXA) | 394,723 | 394,723 |

The cost moves by about 113k between states for rmPROTO and rmAGENT. A limit estimated in the cheaper later state fails with an empty revert when the transaction runs in the costlier state. The test failed for rmPROTO and rmAGENT before the fix.

Fix: `redeem` checks `REDEEM_BASE_GAS + assets.length * REDEEM_GAS_PER_ASSET` (300,000 + 400,000 per listed asset) at entry, before any state-dependent work, and reverts `InsufficientGas(available, required)`. The floor binds in every state, so the estimate lands on it. It counts every listed asset, so it is an upper bound. The runtime size of each basket vault stays under the 24,576 byte limit.

Not proven: that 400k per asset stays above the worst case if a pool is thin and the swap crosses many ticks. Re-run the margin test when the asset list or the pools change.

Fork command: `FORK_RPC_URL=https://mainnet.base.org forge test --match-path contracts/test/BasketVaultRedeemGas.t.sol -vv`. CI runs it in the `forge-fork-vault-regressions` job.
