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

## Panic(0x11) on a redeem eth_call at "pending" (core 1758)
Reported on Deploy 2 (rmUSDC `0x28Bf6E6EDAD526191e8652ee631B56EAd4cE7435`, Base 8453): a redeem of a 1 USDC position at the "pending" tag reverted `Panic(0x11)` at gas 2,000,000 and passed at 3,000,000.

**Root cause: not a gas threshold and not in the vault.** The Panic is an arithmetic underflow inside the Moonwell Flagship MetaMorpho / Morpho Blue code that `MorphoAdapter.totalAssets()` calls on every redeem. Morpho computes `block.timestamp - market.lastUpdate`. When the eth_call environment is older than the last accrual of a market, that subtraction underflows. The vault's gas arithmetic is `gasleft() < floor` comparisons only. It has no subtraction on `gasleft()`.

Evidence (read-only `eth_call` against `https://mainnet.base.org`, no transaction, no key):
- A plain view call, `convertToAssets(305529980762486259)` on the Flagship vault `0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca`, with no gas set, alternated between a normal result and `Panic(0x11)` over six consecutive calls at the "pending" tag. The same call at "latest" returned 333302 every time.
- Redeem at "pending" with state overrides gave `ok` at 1.7M and 2.0M and `Panic` at 2.5M and 3.0M in one run, then `Panic` at every limit from 1.7M to 2.5M in the next run. The gas-versus-outcome pattern in the report is one sample of this intermittent behavior.
- The same redeem simulated locally at the "pending" tag succeeded (1,093,389 gas) with the same overrides, so the failure is in the node's pending environment, not in the contract path.
- Inferred, not proven: the node's pending (flashblock) state includes a Morpho accrual stamped later than the environment timestamp it hands to the EVM. The node rejects `debug_traceCall`, so the exact environment values were not observed.

On chain this cannot happen, because a mined block has a timestamp at or after every accrual before it. Real redeems succeed (txs with gas used about 0.94M to 1.0M).

Reproduction in CI (Twin fork): `test_core1758_panicIsMorphoTimestampUnderflow_notAGasThreshold` runs the redeem one second before the last accrual. The Moonwell adapter `totalAssets()` gives `Panic(0x11)`. The redeem gives the identical payload at every limit from 1.7M to 3.0M. In a consistent environment the same redeem succeeds.

Gas arithmetic checks: `test_core1758_gasSweep_neverPanics` sweeps 500k to 3M in steps of 25k, in the accrued-this-block state and one block later. Every point is success, `InsufficientGas` or an empty out-of-gas revert, and every point below the 1.6M entry floor fails. `test_core1758_estimateConverges_forOneUsdcPosition` bisects the smallest passing limit (what `eth_estimateGas` does) for a 1 USDC position. It lands between 1.6M and 1.7M in both states, the redeem passes at it, and one gas below it reverts `InsufficientGas`.

**Contract change and redeploy:** none. The root cause is outside the vault, so there is no bytecode change and no new deployment is required for this issue. Estimators that hit the node's pending environment can still see the Panic intermittently. Clients should estimate against "latest".

Open design option, not taken: a `try/catch` around adapter `totalAssets()` would hide the Panic but would also let a failing adapter report zero NAV, which under-pays redeemers. It was rejected for that reason.

## Dust redeem reverts "Too little received" (core 1778)
Reported on Deploy 2 (Base 8453): after a 1 USDC router deposit, rmPROTO (`0x28C5ca4DF0107679bFcc9b0ad4c2f3F209b8f797`) `redeem` from the deployer reverted. Tx `0x5e9810f19835379bd1bf7b33b1062fa51facc496dbd830eef7b88c81bcaf0b51` (block 52491837, limit 3,000,000, gas used 551,483, status 0). `redeemInKind` then worked.

**Root cause: not gas, not the redeem gas floors.** The revert string is `Too little received`, which the Uniswap V3 SwapRouter02 raises when `amountOut < amountOutMinimum`. The vault holds 10,287,921,115,868 wei of wETH and 31 base units of cbBTC for the whole 52,224-unit USDC position (a 5.25 percent leg of 1 USDC). The redeem sold every leg through the router with a floor of `TWAP(sellAmount) * (1 - 1%)` (that loop is `BasketVault._sellProportional`).
- wETH leg: sold for 26,222. Fine.
- cbBTC leg: 31 units. TWAP value 25,981, so the floor was 25,721. The pool paid 25,133. cbBTC has 8 decimals and one unit is worth about 838 raw USDC. The pool takes the 0.05 percent fee, then rounds the input down, which is `floor(31 * 0.9995) = 30` units. One unit is 3.2 percent of 31, which is more than the 1 percent bound.
- The router reverts, the vault bubbles the string up, and the whole redeem reverts. The earlier legs' swaps roll back with it.

Evidence (read-only, no transaction sent): a Base fork at block 52491836 replayed as the deployer, `redeem(52224e18, me, me)`, reverts `Too little received` at 557,779 gas (chain: 551,483). The trace shows `exactInputSingle(cbBTC to USDC, amountIn 31, amountOutMinimum 25721)` and the pool transferring 25,133. `test_fork_rmproto_dustRedeemSellsEveryLeg_core1778` (`contracts/test/BasketVaultRedeemGas.t.sol:274`) reproduces it on a fresh `DeployProtocolAssetVault` deployment. It deposits 1,000 USDC, then redeems the share fraction whose cbBTC leg is 31 units, the leg of both failing positions. First it sells that leg alone on the forked Uniswap pool with no floor and asserts the pool output sits under the old floor and at or above the fixed floor (`_assertFloorsAroundPool`). With the old floor as its minimum output, that sale would revert with the same string. Then the redeem must pay out. (A deposit of only 0.05 USDC can also trip `DepositBelowSlippageFloor` at some blocks, for the same rounding reason. That is a separate path, not part of this fix.)

Why `redeemInKind` worked: it transfers the basket tokens and does no swap, so no floor applies. Why the other vaults passed: rmRWA and rmAGENT hold different assets and larger legs. rmUSDC has no swap. A position of a few cents is the trigger, so real-size positions are not affected: the one-unit error is below 1e-6 of a leg above a few million units.

**Live position (2026-10-13).** An outside wallet (`0x2B918144e4Aa55450a542743e7d52CB7eE5a02b6`) holds the whole rmPROTO supply (52,121e18 shares). On a read-only fork at block 52,552,571, impersonating that wallet, `redeem` reverts `Too little received`. The vault holds 31 cbBTC units, so the leg is 31 units. The old floor is 25,534 raw USDC. The pool pays 24,985, which is 2.2 percent under that floor and 3.1 percent under the TWAP value. The fixed floor is 24,710, and the pool pays above it. The cause is the same one-unit rounding as the deployer's failure. These numbers come from a one-off fork run, not from a test in the repo. No test replays that wallet, so CI never depends on it still holding the position. `test_fork_rmproto_dustRedeemSellsEveryLeg_core1778` (`contracts/test/BasketVaultRedeemGas.t.sol:274`) builds the same 31-unit cbBTC leg on a fresh deployment and asserts the same order: the pool output is under the old floor and at or above the fixed floor. The user's `previewRedeem` of 0.051591 USDC is the TWAP estimate, which does not model the pool's rounding.

**Fix** (`contracts/vaults/BasketVault.sol`, `_sellProportional`): the floor prices `sellAmount - 1` units instead of `sellAmount` (`assetUsdcValue(i, sellAmount - 1)`). That covers the pool's one-unit input rounding. The 1 percent slippage bound is unchanged. A one-unit leg floors at zero, because every adapter returns 0 for a zero amount. Since QA plan D6 a leg whose floor is zero is dust: the redeem skips it and it stays with the remaining holders. For a normal leg the change in the floor is below 1e-6. Cost at PR 1784: 10 bytes of runtime code, so the `VaultCodeSizeGuard` headroom floors dropped by 10. Later changes moved those floors again. The current values are in `contracts/test/VaultCodeSizeGuard.t.sol`.

**Deployed vaults:** the Deploy 2 vaults run the old bytecode. The fix reaches them only through a redeploy. The vaults are not behind a proxy, so a fix needs a new rmPROTO deployment, a registry entry and a router re-point through the timelock. The one live lever is `setMaxSlippageBps` (ADMIN, so the timelock). The live leg clears only at about 4 percent (cap 5 percent), which loosens every redeem on the vault. It is not recommended. Until then the supported workaround for a dust position is `redeemInKind(shares, receiver, owner)`, which pays out the basket tokens. Positions above a few cents redeem normally.

**Note for the external deposit guide (core 1798).** Outside users follow devops' deposit guide, which lives outside this repo. Core cannot edit it, so its owner pastes the note below. The note holds for the Deploy 2 basket vaults, which all run the bytecode from before the fix. `redeemInKind` stays a valid exit on every basket vault after a redeploy too.

> **Small basket positions (rmPROTO, rmAGENT, rmRWA).** A basket vault sells each token it holds back to USDC when you redeem. Each sale has a minimum price: on rmPROTO it is 1 percent under the average market price. A position worth a few cents holds only a handful of base units of a token. The pool rounds the input down by one unit, which can miss that minimum. The redeem then reverts with `Too little received` every time you try it. Your shares are safe. Exit in kind instead: `redeemInKind(shares, receiver, owner)` burns the shares and sends you your part of the vault's idle USDC and of each basket token, less the exit fee. It sells nothing and reads no price, and no pause blocks it. The dapp shows this hint when its redeem simulation fails, but it does not send `redeemInKind`. Call it from your wallet or with `cast`, signing as you usually do (for example `--account <keystore>`):
>
> ```
> cast call <vault> "balanceOf(address)(uint256)" <you> --rpc-url https://mainnet.base.org
> cast send <vault> "redeemInKind(uint256,address,address)" <shares> <you> <you> --rpc-url https://mainnet.base.org
> ```
>
> Pass the full share number from the first command, not the short form in brackets. Positions above a few cents redeem to USDC normally.

**Handoff status (core 1798, QA plan v1 W5): not yet sent.** The guide owner has not been told. The QA branch run may not write to GitHub, so no devops issue exists yet. To close the second acceptance item of core 1798: open an issue in the devops repo titled "Deposit guide: add the redeemInKind exit for small basket positions (core 1798)", paste the quoted block above into it, link this section, and then replace this paragraph with the devops issue number and the date the owner acknowledged it.

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

The cost moves by about 113k between states for rmPROTO and rmAGENT. A limit estimated in the cheaper later state fails with an empty revert when the transaction runs in the costlier state. Without the guard, three of the six fork tests fail: the three `*Shifted` tests (rmPROTO, rmAGENT and rmRWA). Each estimates in the cheaper state and includes in the costlier state, which is the failing direction. The three `*Later` tests pass with or without the guard. Each estimates in the costlier state (the deposit block) and includes in the cheaper later state, so the estimate is never short. They cover the safe direction only and do not prove the guard. rmAGENT is measured with the real wETH and cbBTC pools supplied by the test, because those measurements pre-date RM in the shortlist.

Fix: `redeem` checks `REDEEM_BASE_GAS + assets.length * REDEEM_GAS_PER_ASSET` (300,000 + 400,000 per listed asset) at entry, before any state-dependent work, and reverts `InsufficientGas(available, required)`. The floor binds in every state, so the estimate lands on it. It counts every listed asset, so it is an upper bound. The runtime size of each basket vault stays under the 24,576 byte limit.

Not proven: that 400k per asset stays above the worst case if a pool is thin and the swap crosses many ticks. One measurement shows the margin is large: a 1M USDC buy into the deSPXA pool pushed an rmRWA redeem to about 3.8M gas, far above the 700k floor (300,000 + 400,000 for one asset). The floor is an entry check on gas available, not a cap on cost, so the redeem still runs when the limit is high enough. Re-run the margin test when the asset list or the pools change.

Fork command: `FORK_RPC_URL=https://mainnet.base.org forge test --match-path contracts/test/BasketVaultRedeemGas.t.sol -vv`. CI runs it in the `forge-fork-vault-regressions` job.

## ADR-0014: the proxy hop

Since ADR-0014 every vault, the router and the gateway run behind an `ERC1967Proxy`, and the tight contracts call linked libraries (`RobotMoneyVaultOps`, `BasketSwaps`, `GatewayWindows`) by DELEGATECALL. Each call through a proxy adds one DELEGATECALL hop, and each library call adds another. ADR-0014 (Consequences) asks P1 to re-measure the budgets this document sets.

What measures them now. Every test below deploys through the proxies (`contracts/test/helpers/Proxied.sol`, the stage scripts, or the devnet publish), so each run measures the proxied path:

- `contracts/test/RobotMoneyVaultWithdrawDepositGas.t.sol` and `RobotMoneyVaultRedeemGas.t.sol` (fork-free): estimate-then-execute and the gas sweeps against the 1.6M entry floors.
- `contracts/test/RobotMoneyVaultRedeemGas.t.sol::RobotMoneyVaultRedeemGasForkTest`, `RedeemGasGuards.t.sol` and `BasketVaultRedeemGas.t.sol` (fork): the real adapters and pools, against the same floors.
- `contracts/test/CoreStagesFork.t.sol::test_fork_routerDeposit_below6p8M_revertsInsufficientGasWithTheFloor`: the 6.8M four-leg router floor.
- `testing/fork-e2e-rust/tests/gas_estimate_reality_check.rs`: the 920,000 deposit ceiling (QA plan Decisions D6). It now first asserts the vault it measures is a proxy (non-zero ERC-1967 implementation slot), so the ceiling can never be met by a direct vault.

The floors and ceilings are unchanged: the entry floors are checked at entry in each contract's own frame, before the first library call, and a floor a library checks is measured on the 63/64 it receives, so it can only bind later (ADR-0014 P1 record). Not yet recorded: the measured numbers on the proxied path. This branch was built without running tests (QA plan v1 workflow rule), so the first post-merge CI run records them (QA plan Phase Q). If the `deposit gasUsed=` line of suite 05 exceeds 920,000, the ceiling moves only by the deliberate edit `gas_estimate_reality_check.rs` describes, with that line cited.
