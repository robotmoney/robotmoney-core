# Single-vault redeploy into a live deployment

## 1. Purpose, scope and owner decision

This paper specifies one rmPROTO replacement in Deploy 2 on Base (8453). The sell-floor fix (1778) changes the floor to price `sellAmount - 1` ([BasketVault.sol:888-902](../../contracts/vaults/BasketVault.sol)). Deploy 2's old vault has the previous bytecode, according to the supplied deployment record. The deployment script creates a plain contract with `new ProtocolAssetVault`; it does not upgrade the existing address ([DeployProtocolAssetVault.s.sol:63-78](../../contracts/script/DeployProtocolAssetVault.s.sol)).

The owner approved this experiment on 2026-10-13. It is tracked by single-vault redeploy issue (1796), final mainnet deployment phase (1679), and devops redeploy issue (72). The exception to the one-deployment-scheme rule applies to Deploy 2 only. The owner must separately approve this procedure before it can become a final-release deployment scheme.

The result is a new rmPROTO address, the same four-way router allocation, and a retired old vault whose holders can still exit. Shares stay in their original contracts. This procedure changes no other vault's configuration.

**Implementation status:** code citations describe core source at `17c57e52`, the base of this documentation branch, unless the implementation (1797) or a QA plan v1 task is named. The tooling exists (single-vault redeploy implementation (1797), plus QA plan v1 E1 and E2). The deployer runs the **`redeploy-vault` verb** (`bun publish-contracts/src/cli.ts redeploy-vault --vault PROTO`, which runs `RedeployProtocolAssetVault.s.sol`). The Safe then runs the **govern row** `govern --row redeploy-vault`, the six-call batch in §4. The verify after it runs at the redeploy SHA with **`--prior-out`** (`verify --core-sha <redeploy SHA> --prior-out <forge out/ of a checkout at the original SHA>`, §7). The operator steps are the release runbook section "Redeploy one vault into a live deployment" ([contract-release-runbooks.md](../operations/contract-release-runbooks.md) §4.11); the arguments and evidence fields are in [publish-contracts/README.md](../../publish-contracts/README.md). The acceptance of single-vault redeploy issue (1796) has two halves. The **code half** is that tooling and its tests ([redeploy-vault.test.ts](../../publish-contracts/tests/redeploy-vault.test.ts), [RedeployProtocolAssetVault.t.sol](../../contracts/test/RedeployProtocolAssetVault.t.sol)). The **operator half** is one operator run of this procedure on the Base mainnet rehearsal deployment, its evidence recorded under `deployments/base-8453-rehearsal/`; it has not happened. The client changes in §8 remain requirements. A release containing only the sell-floor fix is insufficient to execute this procedure.

## 2. Preconditions

- Select an immutable release tag containing the sell-floor fix and the completed redeploy tooling. Tag, checkout SHA, deployment sheet, artifacts, and library code must agree. The release gate checks tag/checkout agreement ([release-tag.ts:29-38, 54-65](../../publish-contracts/src/release-tag.ts)). **The qualifying tag is unknown.**
- Freeze the old vault's verified configuration. Copy USDC, swap router, TVL cap, per-deposit cap, exit fee, fee recipient, asset order, active flags, pool addresses/fees, TWAP windows, minimum liquidity, allowed adapter code hashes, slippage, and NAV deviation guard. Constructor inputs and deployment configuration are separate ([DeployProtocolAssetVault.s.sol:63-78](../../contracts/script/DeployProtocolAssetVault.s.sol); [BasketVaultDeployBase.sol:297-339, 372-389](../../contracts/script/BasketVaultDeployBase.sol)). Role holders change through the bootstrap handover in §4; do not confuse the temporary constructor admin with the final timelock admin.
- Reuse the verified linked libraries. The proto stage names TickMath and the three shared libraries BasketAssetConfigGuard, TwapTickMath, and BasketViews ([stage-table.json:147-175](../../scripts/deploy/stage-table.json)). TickMath's address/code hash is checked by the deploy script ([BasketVaultDeployBase.sol:354-369](../../contracts/script/BasketVaultDeployBase.sol)). The complete live library addresses/code hashes and constructor/config values are **unknown** until the public Deploy 2 manifests and chain reads agree. Never substitute current repository defaults for that evidence.
- Record the existing router's `routerCap` and `vaultCap(old)`. The latter is keyed by address; zero means uncapped ([PortfolioRouter.sol:584-590](../../contracts/PortfolioRouter.sol)). The new address must receive the same approved router cap as old, in addition to its own vault caps. Record the old vault's `registry()` binding too; the retirement hook accepts only that registry ([BasketVault.sol:1235-1249](../../contracts/vaults/BasketVault.sol)).
- The designated deployer pays deployment/configuration gas. Its funding source and gas budget are **unknown** and require an operator funding record. The round-trip account needs exactly 1 USDC plus transaction gas. No seed deposit is part of this procedure. Production keys are never used in tests ([security-model.md:383-388](security-model.md)).
- Re-read the Safe owners/threshold, all governed roles, old status/eligibility, router default/effective vectors, `votedWeightsActive`, pause/shutdown/retired flags, share supply, holder balances, allowances, asset bindings, and code hashes before scheduling. Require old Active/eligible, the recorded split, four distinct legs, no active voted vector, and an absent new registry entry. A mismatch stops the ceremony; a read is not an authorization to repair unrelated state.
- Inventory queued/ready governance operations, receipt applications, votes, and pause/unpause rounds. Cancel conflicts before scheduling the cutover. Repeat the check before execution. Tool checks cannot prevent another public executor from running a ready operation; §5 states the remaining coordination requirement.

Deploy 2's recorded addresses are below (`devops/docs/plans/deploy-correctness.md:113-127`). Reconfirm them in the execution evidence.

| Name used below | Address |
|---|---|
| Safe | `0xdFDea0E1AdF55a9a938bD34ead7920175b47Cb4b` |
| Timelock | `0xd65165AF0Fb4062ED0da5D119d4B56B92b15356b` |
| Router | `0xB3a8e66d9E2980B54aC0e70e0e236486D1DCb356` |
| Registry | `0x686EbEFda732DffA988253Ecf9c012946B8066A3` |
| `old` rmPROTO | `0x28C5ca4DF0107679bFcc9b0ad4c2f3F209b8f797` |
| rmUSDC | `0x28Bf6E6EDAD526191e8652ee631B56EAd4cE7435` |
| rmAGENT | `0x22bD48C56c34A2C1C1baC77BD7c4E636a6f10D57` |
| rmRWA | `0x37Be372Bd32f9E63A94C7DB3ab415996658bcd50` |
| `new` rmPROTO | Unknown until deployment; distinct from every address above. |

Run 2 recorded 8550/525/575/350 and no voted vector. It began with a 900-second rehearsal timelock, then raised the delay to 1800 seconds (`devops/docs/plans/deploy-correctness.md:102-110`). The **current delay is unknown**. Read `getMinDelay()` on the governing timelock. Use that value for every new schedule; do not use 900 seconds as a default.

## 3. State before and after

| State | Before | Intended after |
|---|---|---|
| Registry | Four recorded vaults; old Active. New absent. | Five registered addresses: old Retired, new Active, other three unchanged. Registration appends; retirement preserves the record ([VaultRegistry.sol:235-249, 276-287](../../contracts/VaultRegistry.sol)). |
| Eligibility | Old eligible; new absent/ineligible. | Old ineligible; new eligible; eligible count four. Each `migrateEligibility` changes one flag and the complete default vector ([VaultRegistry.sol:432-455](../../contracts/VaultRegistry.sol)). |
| Weights | `[rmUSDC,old,rmAGENT,rmRWA]` at `[8550,525,575,350]`, confirmed from live reads. | `[rmUSDC,new,rmAGENT,rmRWA]` at the same bps. No voted vector; effective weights equal defaults. Voted weights otherwise override defaults ([PortfolioRouter.sol:1160-1174](../../contracts/PortfolioRouter.sol)). |
| New roles | Constructor grants admin and emergency roles to the configured addresses; the standard script initially uses the broadcaster for both ([BasketVault.sol:436-439](../../contracts/vaults/BasketVault.sol); [BasketVaultDeployBase.sol:317](../../contracts/script/BasketVaultDeployBase.sol)). | Timelock is the sole admin; approved independent responder is the sole emergency holder; deployer has no role. Admin is self-administered and administers emergency ([BasketVault.sol:436-439](../../contracts/vaults/BasketVault.sol)). |
| Registry binding | New contract absent. | `new.registry() == existingRegistry`, set once before handover. Registration alone does not bind the vault ([BasketVault.sol:1221-1225](../../contracts/vaults/BasketVault.sol); [VaultRegistry.sol:235-249](../../contracts/VaultRegistry.sol)). |
| Caps and flags | Record old vault caps, router cap, per-address router cap, and flags. | New vault caps match approved old values; `router.vaultCap(new) == recordedOldRouterVaultCap`; global router cap unchanged. New locally open, not retired/shutdown. Old retired; retirement blocks deposits even if its local pause flag is false ([PortfolioRouter.sol:584-590](../../contracts/PortfolioRouter.sol); [BasketVault.sol:796-805, 1235-1269](../../contracts/vaults/BasketVault.sol)). |
| Seed and shares | Old supply/balances recorded. Historical old seed state unknown. | No new seed transaction. The standard basket deploy configures/pauses/registers without a seed call ([BasketVaultDeployBase.sol:317-351](../../contracts/script/BasketVaultDeployBase.sol)). Old shares stay at old; round-trip test shares are redeemed. |
| Pools and recorder | Read old asset/venue/pool/adapter bindings from evidence and chain. | Same verified venues and pool parameters. V3 configuration uses pool addresses; V4 configuration binds a recorder and deploys an adapter ([BasketVaultDeployBase.sol:372-412](../../contracts/script/BasketVaultDeployBase.sol)). Do not copy the rmAGENT recorder into rmPROTO. Actual Deploy 2 rmPROTO bindings remain unknown here. |
| Manifests | Original Deploy 2 files and receipt evidence. | Preserve originals; append a migration record with both generations, full config, roles, operation IDs, and before/after reads. A derived current-address view selects new only after verified execution. |

## 4. Ordered procedure

The deployer bootstraps only the unopened replacement. All live registry/router writes and the final opening run through the existing Safe and timelock. Do not rerun `DeployTimelock.s.sol`: it creates and hands over a deployment-wide timelock. Reuse its vault handover order for the existing timelock address ([DeployTimelock.s.sol:550-555, 589-629](../../contracts/script/DeployTimelock.s.sol)).

| Step | Actor and exact action | Delay | Observation |
|---|---|---|---|
| 1. Deploy/configure closed | Deployer runs the `redeploy-vault` verb, which runs the deploy-only script [RedeployProtocolAssetVault.s.sol](../../contracts/script/RedeployProtocolAssetVault.s.sol). It reuses the `DeployProtocolAssetVault` constructor/configuration logic and never calls `_registerIfAbsent` or an eligibility write (`ROUTER_DEFAULT_BPS=none` alone does **not** suppress registration in the launch script, [DeployProtocolAssetVault.s.sol:6-11, 63-78](../../contracts/script/DeployProtocolAssetVault.s.sol)). The vault is paused immediately after creation, before the first `addAsset`, and keeps the pause through configuration and handover ([BasketVaultDeployBase.sol](../../contracts/script/BasketVaultDeployBase.sol), "Close the bootstrap deposit window before any active asset is installed"; `RedeployProtocolAssetVault.t.sol` `test_redeploy_pausePrecedesFirstActiveAsset`; [BasketVault.sol:796-798](../../contracts/vaults/BasketVault.sol)). | None. Multiple broadcast transactions may be needed. | New address/code/config receipts; `DepositsPaused` when the flag changes. New remains unregistered/ineligible. Require zero supply and verified config before proceeding. |
| 2. Bind and hand over | Deployer, while still admin, calls `new.setRegistry(registry)`; `new.grantRole(EMERGENCY_ROLE,responder)`; verifies responder; `new.revokeRole(EMERGENCY_ROLE,deployer)`; `new.grantRole(ADMIN_ROLE,timelock)`; verifies timelock; `new.revokeRole(ADMIN_ROLE,deployer)` last. The `redeploy-vault` script does exactly this, in the existing script's order ([RedeployProtocolAssetVault.s.sol](../../contracts/script/RedeployProtocolAssetVault.s.sol); [DeployTimelock.s.sol:589-629](../../contracts/script/DeployTimelock.s.sol)). The S5 guard allowlists this one script because it binds only the unopened replacement before handover (`scripts/ci/check-set-registry-owner.ts`). | None. These are bootstrap calls by the current new-vault admin. | `RegistrySet`, role grant/revoke receipts, correct registry binding, full role-holder audit, deployer absent. New stays closed. A timelock that has not received admin cannot grant itself that role. Never revoke the last admin ([BasketVault.sol:436-439](../../contracts/vaults/BasketVault.sol); [AdminFloorAccessControlCounter.sol:68-74](../../contracts/lib/AdminFloorAccessControlCounter.sol)). |
| 3. Prepare/schedule cutover | `govern --row redeploy-vault` builds the six-call batch below (`buildRedeployCalls`) and the operator verifies exact targets, values, payloads, predecessor, salt, and operation ID. The Safe signs/calls `timelock.scheduleBatch(targets,values,payloads,predecessor,salt,delay)`. All values are zero. | `delay >=` the current `getMinDelay()`. | One `CallScheduled` per payload. No registry/router/vault state changes. New remains closed and unregistered. |
| 4. Execute cutover | After readiness and repeated preflight, a public executor calls `timelock.executeBatch` with the **same** arrays, predecessor, and salt. | Must be ready; cannot bypass the recorded delay. | All six calls succeed in one transaction or all revert. Final reads show five registry entries, four eligible legs, old retired, new open, intended caps and weights. |
| 5. Verify/test | Operator runs complete verification and evidence check. A separately funded test holder approves the router and deposits exactly `1_000_000` USDC base units. Record all four legs; redeem the new rmPROTO shares and the other test positions. | None for reads/user transactions. Admin corrections require timelock delay. | With all four available, allocations are `855000 / 52500 / 57500 / 35000` units. Record actual minted shares and actual redemption proceeds. Each funded leg emits `RouterDeposit` ([PortfolioRouter.sol:701-739, 1120-1134](../../contracts/PortfolioRouter.sol)). |

For the test in step 5, the holder calls `USDC.approve(router,1_000_000)`, then `router.previewDeposit(1_000_000)` and `router.deposit(1_000_000,minSharesPerLeg)`. Derive the four minimum-share bounds from the verified preview and approved slippage; record them in order. An empty bounds array disables that protection. Shares are minted to the calling holder ([PortfolioRouter.sol:762-775](../../contracts/PortfolioRouter.sol)). Redeem the measured new-share balance with `new.redeem(shares,testHolder,testHolder)`; use the same owner exit for the other test legs. Record receiver USDC balance changes, not an inferred 1 USDC repayment. Exit fees and swaps affect proceeds ([BasketVault.sol:693-702, 850-858](../../contracts/vaults/BasketVault.sol)).

Use this exact batch, with addresses from the verified migration record:

| Order | Target | Function and arguments |
|---|---|---|
| 1 | Registry | `registerVault(new, VaultMetadata("Robot Money Protocol", USDC, 0))` |
| 2 | Router | `setVaultCap(new, recordedOldRouterVaultCap)` |
| 3 | Registry | `migrateEligibility(new,true,[rmUSDC,old,new,rmAGENT,rmRWA],[8550,525,0,575,350])` |
| 4 | Registry | `migrateEligibility(old,false,[rmUSDC,new,rmAGENT,rmRWA],[8550,525,575,350])` |
| 5 | Registry | `retire(old)` |
| 6 | New vault | `unpauseDeposits()` |

Registration records the actual timestamp, ignoring the supplied `registeredAt` value ([VaultRegistry.sol:235-249](../../contracts/VaultRegistry.sol)). The cap call carries the approved old cap, `router.vaultCap(old)` as the row read it when it planned the round (recorded as `router_vault_cap`); a new address reads 0, which the router treats as uncapped, so the cap lands before the new vault becomes eligible. The read-back label `redeploy[rmPROTO]: router per-address cap equals approved old cap` checks it. The first migration raises eligible count to five and preserves the old leg's allocation. The second lowers it to four and replaces old with new. Both vectors list every eligible address once and sum to 10000. The router checks count, Active status, eligibility, and sum; it does not enforce uniqueness ([VaultRegistry.sol:432-455](../../contracts/VaultRegistry.sol); [PortfolioRouter.sol:537-563](../../contracts/PortfolioRouter.sol)). Retirement must follow old ineligibility. Opening is last ([VaultRegistry.sol:276-287](../../contracts/VaultRegistry.sol); [BasketVault.sol:1260-1270](../../contracts/vaults/BasketVault.sol)).

No separate `setDefaultWeights` call is needed: `migrateEligibility` calls `applyMigrationDefaultWeights` ([VaultRegistry.sol:450-455](../../contracts/VaultRegistry.sol); [PortfolioRouter.sol:527-531](../../contracts/PortfolioRouter.sol)). Expect `VaultRegistered`, `VaultCapSet`, two `RouterEligibilityChanged`/`DefaultWeightsSet` pairs, old `Retired`/`VaultStatusChanged`, and new `DepositsUnpaused`, in that order. The function citations above define those events.

OpenZeppelin's timelock computes the batch ID from the exact arrays/predecessor/salt. It executes calls in order, propagates failures, emits `CallExecuted` per call, then marks the operation done (`lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:291-311, 385-437`, pinned dependency `dbb6104c`). The repository already exercises signed Safe batch scheduling/execution ([SafeIntegration.t.sol:1473-1503](../../contracts/test/SafeIntegration.t.sol)). Use a fresh migration-specific salt. Set the predecessor to a verified required operation, or zero when none is needed. Archive both values. An execution revert does not undo the earlier scheduling transaction; the operation remains retryable until cancelled.

## 5. Interleaving risk

The router first computes availability using registry Active status and eligibility. It renormalizes the weights of available legs and assigns rounding residue to the last positive-weight available leg. Zero allocations are skipped. Caps remain hard bounds ([PortfolioRouter.sol:701-754, 1017-1030, 1064-1069, 1112-1131](../../contracts/PortfolioRouter.sol)).

A vault-local pause is different from registry `DepositsPaused`. Local pause makes the vault's `maxDeposit` zero but leaves router availability unchanged. A positively funded local-paused leg reverts the entire router deposit. Registry non-Active status makes the router skip that leg and renormalize; the registry status setter also drives the vault's retirement hook ([BasketVault.sol:796-805](../../contracts/vaults/BasketVault.sol); [PortfolioRouter.sol:745-754, 1128-1131](../../contracts/PortfolioRouter.sol); [VaultRegistry.sol:327-359](../../contracts/VaultRegistry.sol)).

`previewDeposit` shares the allocation calculation, but it is not a promise that deposit succeeds. A vault preview failure marks the preview unavailable **after** allocation; it does not redistribute that allocation. A local pause or cap may only fail at deposit time ([PortfolioRouter.sol:647-680, 695-700](../../contracts/PortfolioRouter.sol)). This is the paused-leg decision (1705), question Q3.

| Visible interval or unsafe partial state | Deposit / preview | Redeem | Receipt, pause, keeper |
|---|---|---|---|
| Deployment/configuration transactions | Old router split remains. The `redeploy-vault` verb's script pauses the new vault right after creation, before the first asset is added, so `maxDeposit` stays zero and a direct `deposit` reverts `DepositsArePaused` through configuration and handover; no direct-deposit window opens (`RedeployProtocolAssetVault.t.sol` `test_redeploy_pausePrecedesFirstActiveAsset`; [BasketVault.sol:796-798](../../contracts/vaults/BasketVault.sol)). | Existing holders keep their exit paths. | Freeze conflicting governance work. New cannot be reached through the router until registered/eligible. |
| Handover through schedule/readiness | New is closed and absent from registry. Old remains the routed rmPROTO. | Old registered shares remain reachable through router `redeemFor`. | Local emergency pause may change deposit availability at execution time. Cancel stale opening batches. A receipt application can change defaults; voted weights can override them. |
| Intended cutover execution | No other transaction can land between batch calls. The five-leg zero-weight intermediate state and new positive-weight closed state never persist as separate transactions. | Existing holdings are unchanged. | Atomicity does not cure bad calldata or a previously active voted vector. A public executor can choose when the ready batch executes. |
| If registration/cap alone were sent separately | Old split remains; new is Active/ineligible/closed. | Old exits continue. | An abort can leave this unused registration; verify it explicitly. This is not the specified batch. |
| If adding new eligibility lands alone | Five-leg vector keeps new at zero. Current source skips the new leg and uses the old split; prove this against the existing router's bytecode before relying on it ([PortfolioRouter.sol:1064-1069](../../contracts/PortfolioRouter.sol)). | Old exits continue. | A later vector change can fund the paused leg. Stop and repair through governance. |
| If removing old eligibility lands before opening | New is Active/eligible/locally paused at 525 bps. Router preview can quote it; router deposit reverts as a whole. Old direct deposits remain possible until retirement. | Both registered generations can exit. | Do not resume user deposits from a partial record. |
| If old is removed first using a three-leg vector | No rmPROTO leg. Deposits follow that temporary vector; unavailable legs elsewhere cause further renormalization. | Old shares still exist. | This is an alternative partial sequence, not the specified cutover. |
| After cutover | Four intended legs. A local pause, cap, pool guard, or swap failure can still revert the complete router transaction. | Old redeem remains independent of current weights/status ([PortfolioRouter.sol:850-950](../../contracts/PortfolioRouter.sol)). | Receipt application must resolve protocol bucket to new. Keep both vault generations in pause monitoring. |

Receipt application derives vault addresses from manifests and validates the eligible set; an active voted vector blocks its CLI path ([apply-receipt.ts:49-58, 68-116](../../publish-contracts/src/apply-receipt.ts)). Stale application evidence can still refer to old. Cancel pending conflicting operations, retain historical evidence, and rebuild future operations from the verified current map. Leave RouterGovernance deployment/role changes to its existing work; do not fold them into this experiment.

A pause arriving after scheduling makes the final unpause stale. The existing tool tracks pause/unpause sequence ordering; the redeploy operation needs equivalent checks ([govern.ts:31-39, 525-537](../../publish-contracts/src/govern.ts)). Those checks are off chain. Cancel must be mined before an open executor executes; re-reading immediately before an operator execution cannot stop another executor. Keep the new vault closed until governance coordination and monitoring are ready.

Keepers do not have registry admin authority under the intended handover. BasketVault's global `rebalance` is a stub that reverts `NotImplemented`; do not invent a keeper rebalance step for rmPROTO ([BasketVault.sol:1522-1531](../../contracts/vaults/BasketVault.sol)). Price observations and pool liquidity may change while an operation waits. Verify their deposit guards again; a successful schedule says nothing about later swap execution.

## 6. Old vault and holder exit

`retire(old)` changes registry status and sets old's dedicated `retired` flag. It preserves shares, assets, and the registry address. `unpauseDeposits` cannot clear retirement ([VaultRegistry.sol:276-287](../../contracts/VaultRegistry.sol); [BasketVault.sol:1235-1269](../../contracts/vaults/BasketVault.sol)).

“Withdrawals never frozen” means governance and emergency pause do not gate supported exits. For rmPROTO, use `redeem` for USDC; exact-asset `withdraw` reaches `previewWithdraw`, which reverts `RedeemOnly`. USDC redemption still needs enough gas, usable pricing, and successful swaps ([BasketVault.sol:693-702, 823-855](../../contracts/vaults/BasketVault.sol)). Retirement does not guarantee a successful USDC quote or swap.

A holder such as `0x2B918144e4Aa55450a542743e7d52CB7eE5a02b6` keeps their old rmPROTO shares. They can redeem from old, or call `old.redeemInKind(shares,receiver,owner)` for a basket exit. A caller other than the owner needs share allowance. The in-kind path burns shares and transfers proportional idle USDC plus active basket tokens, with per-leg exit fees/rounding. It uses no oracle or swaps and has no pause/shutdown/retirement/role gate. Removed inactive assets are excluded ([BasketVault.sol:705-720](../../contracts/vaults/BasketVault.sol)). Token transfers can still fail.

Router `redeemFor` accepts caller-named registered vaults independently of routing weights and lifecycle status ([PortfolioRouter.sol:850-950](../../contracts/PortfolioRouter.sol)). Clients must offer the old address to existing holders. No old shares become new shares automatically. Entering new requires a separate deposit after exit.

## 7. Verifier and evidence changes

The verify after a round is `bun publish-contracts/src/cli.ts verify --core-sha <redeploy SHA> --prior-out <forge out/ of a checkout at the original SHA>`, with the usual chain, RPC, sheet, signer, environment and evidence arguments. The manifest loader supplies one address per vault in the stage table; after the `redeploy-vault` verb the vault manifest names the replacing vault. The verifier adds the retired vault of each governed round in the run manifest's `vault_redeploys`, so the registry's complete address set must equal the manifests plus the retired generations, and no other extra address is accepted ([manifests.ts:44-56](../../publish-contracts/src/verify/manifests.ts); [verify/index.ts](../../publish-contracts/src/verify/index.ts), `expectedSet`). Its `retired[rmPROTO]` and `redeploy[rmPROTO]` labels check both generations, including `redeploy[rmPROTO]: router per-address cap equals approved old cap`.

Required checks:

- New runtime matches the selected artifact. Existing build comparison masks immutables/library links; verify their actual values and library code hashes separately. Record raw runtime hashes of both generations ([verify/index.ts:203-212](../../publish-contracts/src/verify/index.ts)).
- SHA model (QA plan v1 E1): the deployment ran at the original SHA, and the run manifest keeps it. The `redeploy-vault` verb runs at the redeploy SHA (the fix's tag) and records it as the round's `core_sha`. `govern --row redeploy-vault` and `verify --prior-out` then run at that redeploy SHA; the row may also run at the original SHA, with the same operation. Verify compares the replacing vault with the checkout's build and every other contract (core, libraries, adapters, the other three vaults, the retired vault) with `--prior-out`, the `out/` of a git checkout at the original SHA. A passing verify records `prior_out_sha` and `verified_at_sha` on every governed round. Once a round ran at another SHA, `evidence-check` requires both on every round: `verified_at_sha` is that SHA and `prior_out_sha` is the evidence `core_sha`. Otherwise it checks them when present. Neither run needs a frozen counts file for the redeploy SHA: the counts are the original SHA's file, else the run manifest's per-stage counts. A verify at the original SHA after such a round, or at the redeploy SHA without `--prior-out`, is refused before any signer. So is every other run that reaches the verify stage: the default stage set (`--resume` included), `--stage all`, or a `--stage` list naming verify, at the original or at the redeploy SHA. A `--prior-out` that is not a checkout of the original SHA is refused on all of them. The verify stage also refuses a wrong build itself and pauses nothing. No run can fail the verify on the wrong build and pause the four vaults ([redeploy-vault.ts `redeployShaRun`, `verifyBuildRefusal`](../../publish-contracts/src/redeploy-vault.ts)).
- New configuration matches the approved baseline, including registry binding, every asset/venue/adapter/pool, oracle settings, fees, and both vault and router caps. Match the other three vaults against their unchanged baseline.
- Timelock is the sole new-vault admin; approved responder is the sole emergency holder; deployer holds nothing. Check every role found in grant/revoke history, including unexpected roles. BasketVault's access-control base is not enumerable; scan logs from creation, replay membership, and confirm each candidate with `hasRole` ([AdminFloorAccessControlCounter.sol:8-19](../../contracts/lib/AdminFloorAccessControlCounter.sol)). Extend the existing role scans required by role-holder enumeration issue (1668), rather than assuming `getRoleMemberCount` exists on this vault ([verify/index.ts:553-578](../../publish-contracts/src/verify/index.ts)). Incomplete log coverage fails verification.
- Registry contains exactly the original four plus new. Old is Retired/ineligible and locally retired. New is Active/eligible, locally unpaused, not retired/shutdown. Eligible count is four. Verify exit access without burning a production holder's shares: quote/simulate supported calls, and execute funded holder exits in rehearsal.
- Default and effective vectors each contain exactly the four intended distinct addresses. Compare address-to-bps mappings and record order. `votedWeightsActive` must be false. Require 8550/525/575/350 with new in rmPROTO's slot.
- Preserve previously applied receipt evidence. Current verification derives expected vectors from either the sheet or applied-receipt record; that old address cannot remain the expected current leg after migration ([verify/index.ts:248-277](../../publish-contracts/src/verify/index.ts)). Explain the address substitution in the migration record, not by rewriting the historical receipt.
- Verify one executed operation with the exact six payloads (`evidence-check` rebuilds them, the router cap from the entry's `router_vault_cap`). Record chain, tag/SHA, artifact/library hashes, old/new addresses, full config, role history range, before/after blocks and hashes, operation ID/predecessor/salt, Safe transaction, schedule/execution/cancellation hashes, and round-trip balances. Reject missing calls, wrong order, stale addresses, unexplained roles, conflicting voted weights, or evidence not matching chain state.

The migration schema must preserve original manifests and identify both generations by `(chainId,address)`. Select a current logical rmPROTO only after verified execution. The exact schema is **unknown**; single-vault redeploy issue (1796) must specify it before release. Do not make normal verification pass by deleting the old registration from expected evidence.

## 8. Client changes

The stage builder currently loads four vault manifests and requires agreement with the original timelock vault list ([mainnet-dapp.ts:187-200, 225-235](../../scripts/stage/mainnet-dapp.ts)). It needs a validated migration overlay. Preserve original files; derive the current map from executed evidence. Update `VITE_VAULT_ADDRESSES` and the protocol bucket mapping to new ([mainnet-dapp.ts:310-323](../../scripts/stage/mainnet-dapp.ts); [consensusReceiptApi.ts:279-309](../../clients/dapp/src/lib/consensusReceiptApi.ts)).

The existing dapp code-hash pin is for the **gateway**, not each vault ([mainnet-dapp.ts:310-318](../../scripts/stage/mainnet-dapp.ts); [gatewayVerifier.ts:38-55](../../clients/dapp/src/lib/gatewayVerifier.ts)). Keep the gateway pin. Record new rmPROTO's expected hash in migration evidence; if writes must enforce a vault hash pin, add that capability explicitly. The current source does not supply it.

The explorer database keys registrations by chain/address. The API exposes address/status/pause data and per-address positions ([db.rs:1318-1335](../../services/explorer-indexer/src/db.rs); [model.rs:177-205, 465-478](../../clients/explorer-api/src/model.rs)). Keep both rows and label old as retired. Add a tested current-generation relation; do not infer it from the shared name or symbol.

**Exit-indexing gap:** the watched-address query and heartbeat include only Active discovered vaults, plus the statically pinned vault. Retired old rmPROTO drops out of that dynamic set ([indexer.rs:1079-1105, 1176-1185](../../services/explorer-indexer/src/indexer.rs)). Include retired addresses for share transfers, supported exit events, balances, and snapshots. Backfill registration-to-discovery intervals and cutover-block exits. Test old standalone redemption after retirement and after indexer restart, with no router activity. Keep both generations queryable in account history and positions. QA plan X2 closes the watched-set and heartbeat part: every `vaults` row is watched and snapshotted whatever its status, tested by `multi_vault::retired_vault_withdrawals_still_index_and_snapshot` (separate indexer runs, no router activity). `RedeemedInKind` is still not indexed: an in-kind exit moves the old vault's snapshot but not the holder's position.

Update the deposit guide with the current address and expected hash, the effective split, the retirement block, and old-holder USDC/in-kind exits. Publish client changes only after execution evidence selects new. Show retired old holdings separately. Update the harness to assert a **router** 1 USDC deposit with all four allocations, then redeem the resulting shares. A direct 1 USDC new-vault test alone does not exercise the 0.0525 USDC rmPROTO router leg.

## 9. Failure modes and rollback

| Failure point | State and response |
|---|---|
| Deploy confirmation (QA plan v1 E2) | The `redeploy-vault` verb saves the round's `started` record in `publish-run.json` only after the operator and the reviewer confirm. A refused confirmation sends nothing and records nothing, so the next run starts a fresh round. After the confirmation the record is saved before forge broadcasts: a broadcast that dies part-way leaves it open, and only `--resume` with the same arguments continues it ([redeploy-vault.ts `runRedeployVault`](../../publish-contracts/src/redeploy-vault.ts)). |
| Creation/configuration/pause | One reverted transaction leaves no effects from that transaction. Earlier successful broadcast transactions persist; a new contract may exist and may not yet be paused. Inspect receipts and flags. Finish closing/configuration before handover. Never assume the whole Forge script was atomic. |
| Binding/handover | Earlier bootstrap calls may persist. Keep new closed. Read roles and the set-once registry binding before any retry. A wrong registry binding requires a different new vault; it cannot be reset ([BasketVault.sol:1221-1225](../../contracts/vaults/BasketVault.sol)). If deployer admin was already revoked, remaining admin corrections use the timelock. |
| Schedule | No cutover state changes. If a receipt is missing, derive the intended operation ID and read its state before retrying. Do not create a duplicate operation with a different salt. |
| Registration or cap inside cutover | Entire execution reverts; old routing remains and new remains unregistered/closed. `AlreadyRegistered` is an error, not evidence that a prior intended batch succeeded ([VaultRegistry.sol:235-249](../../contracts/VaultRegistry.sol)). Reconcile the actual record before retry. |
| Either migration inside cutover | Entire batch reverts, including registration/cap changes. No five-leg or partially changed default persists ([VaultRegistry.sol:432-455](../../contracts/VaultRegistry.sol); timelock source cited in §4). |
| Retirement inside cutover | Hook failure reverts the full batch. Check old's registry binding and eligibility; no earlier migration in this batch survives. |
| Opening inside cutover | Full batch reverts. Old remains routed; new remains closed/unregistered. It does not leave retired old plus eligible paused new. |
| Verifier or router test | Emergency responder calls `new.pauseDeposits()` if needed. Supported exits remain open. Cancel stale unpause operations; use delayed governance for repair. Local pause can make the whole router deposit revert, rather than skip new ([BasketVault.sol:1254-1270](../../contracts/vaults/BasketVault.sol); [PortfolioRouter.sol:745-754, 1128-1131](../../contracts/PortfolioRouter.sol)). |
| Calls sent outside the batch | Read full state and all operation IDs. Registration, role calls, or a single migration may persist from independent transactions. Do not mark the intended operation complete from a matching address alone. Build a state-specific repair, simulate it, then schedule through the Safe. |

An abort before execution leaves old as the routed rmPROTO; keep the unused new vault closed. Safe cancellation targets `cancel(operationId)`. The Safe is the configured proposer/canceller; the executor is open ([DeployTimelock.s.sol:78-88](../../contracts/script/DeployTimelock.s.sol)). Cancelling an already executed operation cannot reverse it. A failed execution is distinct from a cancelled schedule.

After successful cutover, restoration of old requires a **new approved operation** because old contains the known redeem defect. Do not automatically reopen it. If restoration is approved and both generations remain in the expected state, schedule one inverse batch:

1. `registry.reactivate(old)` to restore Active status and clear old's retired flag.
2. `registry.migrateEligibility(old,true,[rmUSDC,new,old,rmAGENT,rmRWA],[8550,525,0,575,350])`.
3. `registry.migrateEligibility(new,false,[rmUSDC,old,rmAGENT,rmRWA],[8550,525,575,350])`.
4. `registry.retire(new)`.
5. `old.unpauseDeposits()` only if its independent local pause flag must be cleared under the approved repair.

`reactivate` does not clear the local pause flag; `unretire` only clears retirement ([VaultRegistry.sol:296-300](../../contracts/VaultRegistry.sol); [BasketVault.sol:1245-1263](../../contracts/vaults/BasketVault.sol)). One `migrateEligibility(new,false, fourVaults,...)` cannot restore old eligibility: count would be three while the supplied vector has four. Each flag change needs its matching complete vector ([VaultRegistry.sol:441-455](../../contracts/VaultRegistry.sol)). Recheck caps, no active voted vector, and hooks before scheduling. Verify both generations and update the current-address overlay only after execution.

Deployment and append-only registration cannot be erased by this procedure ([VaultRegistry.sol:235-249, 276-287](../../contracts/VaultRegistry.sol)). Old/new supplies stay distinct. Burned shares, completed swaps, transfers, and deposits are not reversed by registry repair. Restoration changes future routing; new holders must retain their exits. No repair changes old bytecode.

## 10. Test plan

The exact post-run-2 block number/hash is **unknown**; the devops plan does not name it (`devops/docs/plans/deploy-correctness.md:102-110`). Record an archival block containing the reported addresses, delay, and split before claiming a Deploy 2 state rehearsal. Do not pin `latest`.

There are two required proofs:

- **Deploy 2 compatibility:** at the recorded block, read bytecode/config/roles and simulate the precise state transitions and old exits. Report any impersonation or storage setup as a test limitation. It cannot prove production Safe quorum.
- **Real governance integration:** on the pinned Twin, deploy a fresh test Safe proxy through the canonical factory, use two ephemeral test-key signatures, and use a real timelock. Run the normal deployment path first, then replace its rmPROTO with the fixed vault. Match the approved Deploy 2 parameters. No mocked Safe quorum or stub timelock ([security-model.md:350-374, 383-388](security-model.md)). Fresh contracts and manifests follow the clean-room rule ([environments.md:141-145](../development/environments.md)).

A test-key Safe is not the existing Deploy 2 Safe. The exact fixture for the compatibility proof and its exception to the fresh-deployment test rule is **unknown** and must be documented in single-vault redeploy issue (1796). Do not silently grant a new test Safe roles on copied live contracts and call that production quorum verification.

These are preparation and existing regression commands, run from the core root. They do not run the new redeploy rehearsal:

```sh
# Separate terminal; requires operator-selected public upstream and archival pin.
# A Twin is a local fork with chain ID 918453 (not a mainnet signer target).
anvil --host 127.0.0.1 --chain-id 918453 \
  --fork-url "${BASE_UPSTREAM_RPC:?set archival Base read endpoint}" \
  --fork-block-number "${DEPLOY_2_FORK_BLOCK:?set verified post-run-2 block}"

forge test --match-path 'contracts/test/VaultRegistry.t.sol'
forge test --match-path 'contracts/test/PortfolioRouter.t.sol'
bun test publish-contracts/tests
```

The Twin shape and permitted test funding/time changes come from [testing-strategy-ethereum.md:11-24](../development/testing-strategy-ethereum.md). The actual redeploy test target/command is **unknown** until implemented. Its output must record pin/hash, chain ID, release SHA, test Safe/timelock addresses, delay, and every bootstrap/cutover receipt.

Add meaningful tests for:

- Deploy-only pauses before the first active asset and leaves new closed/unregistered; interrupted broadcasts cannot expose a configured open vault; correct registry binding; config/library parity; grant-before-revoke; no remaining deployer/unknown role; wrong binding and interrupted bootstrap recovery.
- Exact six-call batch through signed Safe/timelock; insufficient quorum, early execute, replay, cancellation, public execution; failure at each call leaves the entire pre-cutover state intact.
- Both valid intermediate/final vectors; duplicates rejected by tooling; retirement while eligible rejected; wrong count/sum; stale old address; active voted vector; cap parity including zero; guard/pool failure.
- Local pause versus registry pause; zero-amount skip; preview failure without redistribution; unsafe split-call windows; pause arriving after schedule; receipt application with old and current maps; inverse two-migration repair.
- Exactly 1 USDC router input and the four allocated amounts in §4; new-leg USDC redemption; old in-kind holder exit without oracle/swaps; verifier/evidence acceptance and each missing/wrong field; old exit indexing after retirement/restart/backfill.

Mainnet acceptance from single-vault redeploy issue (1796), after a separate operator go decision: effective split 8550/525/575/350 with new; 1 USDC router deposit funds all four; new USDC redemption succeeds at the resulting leg size; old in-kind exit remains supported; before/after verifier passes; evidence check passes; clients preserve both generations. Run 2's historical round trips are evidence of that run, not proof of this replacement.

## 11. Security review

The [contracts security review](https://github.com/robotmoney/robotmoney-core/blob/review/contracts-security-20261012/docs/code-review/20261012-security-review.md) is separate review source, not verification of live Deploy 2 bytecode/state (review scope and disposition). Apply its findings to the affected contract family:

| Finding | Effect on this procedure |
|---|---|
| Excluded adapter value, finding 1 | Concerns RobotMoneyVault. Replacing rmPROTO does not fix rmUSDC's strategy accounting. No adapter exclusion/restoration belongs in this cutover. Keep new's NAV/config checks before opening; a deposit pause alone does not resolve underpaid exits in the reviewed mechanism (review finding 1). |
| Duplicate strategy registration, finding 2 | Concerns RobotMoneyVault `addAdapter`. `registerVault` has its own duplicate-address guard ([VaultRegistry.sol:239-240](../../contracts/VaultRegistry.sol)). Verify one new registry entry and distinct vector addresses. Do not claim this experiment resolves the strategy finding (review finding 2). |
| Force removal, finding 5 | Excludes recoverable strategy assets from NAV and reprices holder exits (review finding 5). Registry retirement instead preserves old assets/shares and only halts deposits. Do not remove funded assets/adapters to simulate migration ([VaultRegistry.sol:276-287](../../contracts/VaultRegistry.sol); [BasketVault.sol:705-720, 1235-1239](../../contracts/vaults/BasketVault.sol)). |
| Duplicate router vectors, finding 8 | Router validation does not enforce address uniqueness ([PortfolioRouter.sol:537-563](../../contracts/PortfolioRouter.sol)). Validate every intermediate/final vector in tooling and evidence. Digest binding alone is not a uniqueness proof (review finding 8). |
| Open executor | Anyone may execute ready fixed calldata. They cannot propose new calldata without proposer authority ([DeployTimelock.s.sol:78-88](../../contracts/script/DeployTimelock.s.sol)). Correct atomic batching prevents external transaction interleaving; it does not prevent timed execution of stale or erroneous authorized calldata. Cancel conflicts before readiness where possible, monitor the queue, and preserve the role/weight invariants. |

## 12. Open questions for the owner

1. **Yes or no:** Keep this procedure limited to the approved Deploy 2 experiment until a separate decision permits it for final deployment? **Recommended: yes.**
2. **Yes or no:** Authorize the two-part rehearsal in §10, including a clearly labelled compatibility simulation of copied Deploy 2 state alongside the clean-room signed-Safe test? **Recommended: yes.** The normal harness rule uses fresh contracts; the supplied task requests the existing Deploy 2 state. The exact fixture exception needs a recorded decision.
3. **Yes or no:** Require a separate operator go decision after the qualifying release, fork evidence, and client/evidence changes pass, before any live cutover or funded test? **Recommended: yes.** This paper grants no deployment authorization.

The remaining unknowns are execution inputs, not new policy questions. Record them under this section before implementation/rehearsal is accepted:

| Unknown input | Required evidence / owner |
|---|---|
| Qualifying release tag/SHA | Release owner selects the tag containing the fix and completed tooling. |
| Current delay, Safe quorum, roles, state | Devops records chain reads at an identified block; reconcile with public run evidence. |
| Old constructor/config and linked libraries | Devops archives complete manifests plus verified chain reads. |
| Independent responder and deployer funding | Operator names the approved responder, gas funder/budget, and 1 USDC test holder. |
| Exact post-run-2 fork block/hash | Devops selects archival pin and proves the required state. |
| Migration schema, client generation relation, fixture, rehearsal command | Single-vault redeploy issue (1796) specifies and implements them before release. |
| Historical old seed state | Read public original deployment evidence; do not infer a new seed requirement. |

## Contradictions and unknowns

- The original issue's “register, retire, migrate” order contradicts `RetireWhileRouterEligible`. Migration must remove old eligibility before retirement ([VaultRegistry.sol:276-287](../../contracts/VaultRegistry.sol)). The issue body is updated with the complete atomic order.
- A timelock cannot bootstrap its own new-vault admin role. The current deployer grants/verifies roles and revokes itself before live governance begins ([DeployTimelock.s.sol:589-629](../../contracts/script/DeployTimelock.s.sol)).
- The supplied 900-second delay is historical; the run plan records a later increase to 1800. Current `getMinDelay()` and the exact fork block remain unknown.
- “Withdrawals never frozen” does not make rmPROTO's exact-asset `withdraw` usable; its supported exits are `redeem` and `redeemInKind` ([BasketVault.sol:693-720, 823-824](../../contracts/vaults/BasketVault.sol)).
- Four-manifest verification and the dapp's original timelock vault list do not accept an additional retired generation. The indexer's Active-only watched set missed future old exits (QA plan X2 now watches every status). These gaps belong to single-vault redeploy issue (1796), not a new duplicate issue.
- Current source skip/pause behavior and review findings are not proof of the immutable Deploy 2 router's bytecode. Verify the actual deployed artifact before claiming that behavior in rehearsal or execution.
