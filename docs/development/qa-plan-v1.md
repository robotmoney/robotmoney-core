# QA plan v1 — bake every feature on `qa/test-merge-v1`

Status: draft for owner approval. Date: 2026-10-14. Base: `origin/dev` 4ad3e1d4 plus the 8 open PRs (1690 1693 1785 1787 1797 1799 1805 1818) merged at b64464ad.

## How this plan is used

- One branch, no PR cycle, no per-task CI or QA gate. Work runs top to bottom through the workstreams below, in task order. A task is done when its code, its named test, and its doc line exist on the branch. Nothing waits for green CI until the final QA phase (Q).
- Each task lists what it covers: open GitHub issues (`#NNNN`) and review findings from the 2026-10-14 adversarial pass (IDs below). Every one of the 41 open issues appears in exactly one task or in the "closed" list at the end.
- Standing decisions that bind every task:
  - **Hardware signing is optional, never required** (owner, 2026-10-14). No chain, stage, or client may refuse a software keystore because it is not a hardware wallet. Plaintext and env-key refusals on 8453 stay.
  - ADR-0010 is Rejected: the multi-family vault design stays.
  - ADR-0009 holds: a retired vault is withdraw-only; the single-vault redeploy moves router eligibility, never shares.
- Owner decisions the plan needs are in section "Decisions". Each has a default; work proceeds on the default until the owner says otherwise.

Finding ID prefixes: CS contracts security, E economics, DT deploy tooling, QD QA-diff, DI indexer/API, DR dapp/rmpc, T tests/CI, F docs. The full findings are in `~/tmp/robotmoney-core-issues/review/` (not on the branch).

## Headline verdict of the review

The vault accounting, reentrancy, role handover and rounding are clean. The branch is not shippable today for five reasons, all fixable in workstream A and B:

1. Four required checks are red on this tree: `publish-contracts-tests` (3 type errors in `tests/redeploy-vault.test.ts`), `forge-unit-tests` (the 1787 PoC tests still assert the spoof that 1818 now reverts; `setRegistry` guardrail gate hit by `RedeployProtocolAssetVault.s.sol`), `core-stages-offline` (same gate), `generated-docs-freshness`.
2. No owner signer can exist on 8453: the parser refuses bare `ledger`, the floor refuses `ledger:PATH@0xOWNER` and every keystore. A mainnet publish would broadcast stages 1–10 and die at `CONTROL_NOT_PROVEN` with the deployer holding every role.
3. The single-vault redeploy cannot reach a green verify at either SHA (manifest pins the original SHA, the verb must run at the fix SHA), and a refused confirmation wedges the manifest.
4. The indexer never fetches the first-tick deposits of a newly registered vault and stops watching paused or retired vaults, so TVL and positions drift after any redeploy.
5. Three CI surfaces are green for the wrong reason: the nightly Twin rehearsal has never run (permissions), the cargo coverage checker credits every rmpc target, and the swarm preflight guard always passes.

## Workstream A — Make the branch buildable (do first, all small)

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| A1 | Fix the three `TS2345` errors in `publish-contracts/tests/redeploy-vault.test.ts:280,480,481` (`as const` tuple → typed array; `topics: Hex[]`). Remove unused imports (`VaultKey` in `redeploy-vault.ts:23`; `mkdirSync`, `decodeEventLog` in the test). | QD-2, DT-6, QD-11 | `bun x tsc --noEmit -p publish-contracts` exit 0 |
| A2 | Flip the three security-review PoC tests to `vm.expectRevert(CommitteeAgentNotCaller.selector)` (`SecurityReviewCommitteePoc.t.sol:34-39`, `SecurityReviewRecheckCommitteePoc.t.sol:66-75,81-97`). Keep the negatives in `ICGatewayIntegration.t.sol:187-227`. | T1, #1790 | `forge test --match-contract SecurityReview` green |
| A3 | `RedeployProtocolAssetVault.s.sol` calls `setRegistry` (lines 10,22,99) and trips the S5 guardrail (`scripts/ci/check-set-registry-owner.ts`). Move the registry link into the govern batch (timelock holds ADMIN_ROLE on the new vault) so the gate stays exact. | QD-3 | gate passes with no allowlist entry |
| A4 | Regenerate `forge doc` output for `SafeIntegration.t.sol` (`test_selfAdmin_*`), `RedeployProtocolAssetVault.s.sol` and its test. | QD-4 | `generated-docs-freshness` green |
| A5 | Restore the sequential owner-signer construction loop dropped in the 1693 merge (`cli.ts:429` `Promise.all` → `for … await sg.address()`). | QD-8 | prove-control test through `main()` with `castRunner` |
| A6 | Drop PR 1805 from the branch bookkeeping: it is an empty "initialize worktree" commit that would close #1447 with no change. (#1447 is re-scoped in B6.) | QD-10, DT-8, #1447 | n/a |

## Workstream B — Signing, confirmation and governance floors

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| B1 | **Revert the hardware-only owner-signer floor.** `floors.ts:51-55` `assertOwnerSignerSpec` on 8453 accepts keystore specs and `parseOwnerHardwareSpec` specs; it still refuses plaintext, env and bare-key specs via `assertSignerSpec`. `cli.ts:272-274` keeps the grammar check for hardware-like specs only. Add a pre-stage-1 refusal on 8453 when fewer `--owner-signer` specs than sheet owners are given (today it dies at `CONTROL_NOT_PROVEN` after stages 1–10). Align `README.md:30,67`, runbook `:99,254,285-289,612`, `security-model.md:98`, `governance-isomorphism.md:52-55`; add exit 29 to the README exit table. | DT-1, QD-1, T6, F1, #1669 | `floors.test.ts`: on 8453 `keystore:…` passes, `ledger:m/44'/60'/0'/0/1@0x…` passes, `env:` refused; `main()` with two owner specs for a three-owner sheet exits before stage 1 |
| B2 | Close the `CONFIRM=environment` bypass: `floors.ts:104-110` / `runner.ts:457-472` accept it on 8453 only with an Actions-only proof (`ACTIONS_ID_TOKEN_REQUEST_TOKEN` present and an OIDC token that verifies), else refuse. | DT-3 | `floors.test.ts`: `CONFIRM=environment GITHUB_ACTIONS=true` outside Actions refused on 8453 |
| B3 | **Timelock proposer floor.** Deploy a thin `TimelockController` subclass whose `_revokeRole` refuses to drop the last `PROPOSER_ROLE` holder (covers `revokeRole` and `renounceRole`); `DeployTimelock.s.sol:555-560` uses it; `govern.ts` refuses `timelock-revoke-role PROPOSER_ROLE` for the last holder. Record the runbook `:668-669` answer: renounce goes through the delay (default b). | CS-3, #1645, #1447 | `DeployTimelock.t.sol::test_lastProposerCannotBeRevokedOrRenounced`; govern negative |
| B4 | Self-admin rows after the Safe changes: `govern.ts:544` compares live owners with the sheet and refuses every later row. Exempt self-admin rows with a read-back against the row's own arguments, and write runbook §9 step "update `SAFE_OWNERS`/`SAFE_THRESHOLD` in the sheet after the change". Key the executed-record on calldata plus Safe nonce so add X / remove X / add X is not skipped. Make the fake `connectSafe` in `govern-world.ts:84` return the mutable owner set, and add the Safe-rule negatives (threshold above owner count, wrong `prevOwner`, cancel below threshold). | QD-5, DT-7, T5, #1645 | `govern.test.ts` "second owner row after safe-add-owner"; "safe-change-threshold above owner count refused" |
| B5 | Run one self-admin row in the Twin publish govern matrix (real SafeL2), not only against the fake. | T5 | twin-publish govern matrix includes `safe-change-threshold` |
| B6 | **Re-scope #1447** to what is real: (a) B3; (b) the recovery-procedure test for 1788/1789 through the real Safe → timelock path (`GovernanceExecutePathAfterHandover.t.sol` extended); (c) register-committee without a public window: the submitter Safe self-authorizes by private commit/reveal before the `register-committee` batch is scheduled (`govern.ts:814,835,1084,1164`, consensus-receipt-submitter-runbook `:124-125`). Everything else in #1447 is covered by closed #1696. | CS-2, #1447 | `ConsensusReceiptSafeSubmitter.t.sol::test_publicRegisterBatchCannotBeFrontRun` |

## Workstream C — Governance core (weight setter, receipts, apply)

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| C1 | **Weight setter `applyReceipt` in one call; delete RouterGovernance voting** (`RouterGovernance.sol:325,380`). Includes: reject duplicate vault addresses in `setWeights`/`_setDefaultWeights` (`PortfolioRouter.sol:456-469,537-553`); remove `VOTED_WEIGHTS_ACTIVE` refusal, `votedWeightsActive` read-back and the voted-weights override from `govern.ts`, `evidence-check`, README `:112`; delete rmpc `governance draft-proposal` (`cli.rs:446-456`); remove explorer-indexer governance/proposal tables and `/v1/governance/proposals` route (migration 00xx); delete the dapp `GovernancePanel`; widen `check_governance_docs.py` to `prd.md` and `architecture.md` and rewrite the voting residues (`prd.md:62,283-285,311-313,493-494`; `architecture.md:640-648,719-721,837,1075,1187,1580,1667`). | #1698, CS-5, F6, #1675 (closed as superseded) | forge: `test_setDefaultWeights_rejectsDuplicateVault`, `test_applyReceipt_setsWeightsInOneCall`; grep gate "no RouterGovernance.propose in clients/"; docs gate green |
| C2 | Apply-receipt and redeploy trust root: `verify-stage.ts:123-124` takes the applied vector from the editable manifest; `govern.ts:967-1043` takes `new_vault` from it. Bind the applied vector to the chain event and `new_vault` to the CREATE receipt `contractAddress` (in the row and in `checkVaultRedeploysOnChain`); put old → new addresses in the Safe description; read `deploy_receipt_statuses` from broadcast receipts instead of writing ones. Drop the README exit-25 sub-item (already done at `README.md:120`). | #1701, DT-5 | `evidence-check.test.ts` "vault_redeploys entry whose new_vault is not the created contract is refused"; forged `receipt_applications` entry refused |
| C3 | WEIGHT_SETTER rotation note: `security-model.md:207` states the per-change delay holds only while the setter is timelock-gated (ADR-0002 `:151-157`); stage-12 verifier records the current holder's gating. | CS-6 | verifier fixture asserts the gating field |

## Workstream D — Contract safety and economics

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| D1 | `RobotMoneyVault.addAdapter` rejects an adapter that any **active** entry already holds (`:954-963`); re-add after `forceRemoveAdapter` stays legal (no inactive reuse in this family, unlike `BasketVault.reuseOrRejectDuplicate`). Fix `smart-contract-invariants.md:168`. | #1789, E3, T11 | `test_addAdapter_revertsWhenAdapterAlreadyActive`, `test_addAdapter_afterForceRemoveSucceeds`; flip the three `test_f2_*` PoCs |
| D2 | **Agent consent on authorize.** A non-`ADMIN_ROLE` `_authorizeAgentInternal` (`RobotMoneyGateway.sol:684-690`) requires an EIP-712 consent signed by `agent` over (owner, shareReceiver, gateway, chainid, nonce); `revealAuthorization` (`:640-676`) carries it. Add a release path for an address authorized without consent. rmpc preflight (`policy/mod.rs:190-192`) also asserts `agents(self).shareReceiver` and `agentOwner(self)` equal its configured values. Reveal replay after success is tested. | #1791, CS-1, CS-2, T11 | `test_squattedAgentDeposit_revertsWithoutConsent`, `test_revealAuthorization_revertsOnReplayAfterSuccess`; rmpc `preflight_refuses_foreign_share_receiver` |
| D3 | **Pro-rata exclusion recovery** (`RobotMoneyVault.sol:968-976,1178-1220`): snapshot holders at exclusion; recovered value from `setAdapterAllowed(true)`, `emergencyWithdrawAdapter` **and** `adminRebalance` (`:1082-1090`, third path) is credited to the snapshot; exiters keep their claim; `redeem` reverts when `grossAssets == 0 && shares > 0` during an open exclusion (today it burns shares for 0 USDC). Rewrite the NatSpec at `:968-976`, `ADR-0010:136` and the seam-map fixture. Indexer and dapp expose the claim (see X7, U5). | #1820, E2 | `test_exclusionRecoveryPaidProRataToSnapshot`, `test_adminRebalanceRecoveryCreditsExclusionRecord`, `test_redeemDuringExclusionRevertsOnZeroPayout` |
| D4 | **Router skips unavailable legs on execute** (RTR-5 known gap). `_availabilityAndAmounts` drops legs whose `maxDeposit` is 0 or whose `previewDeposit` reverts, so preview and execute agree (`PortfolioRouter.sol:676-680,745-754,1065-1069,1128-1131`). Set `NAV_DEVIATION_BPS` for the V4 leg to pool fee + lag budget (default 400) with a deploy assertion `NAV_DEVIATION_BPS > poolFee/100` (twin sheet `:39`, `agent-token-shortlist.json:20-27`). | CS-4, E6, #1779 | `test_RTR5_staleRecorderLegIsSkippedNotReverted`, `test_ORA4_idlePoolDriftInsideFeeBandDoesNotRevertRoutedDeposit` |
| D5 | **Recorder manipulation (decide #1793 with numbers).** E1 model: one `record()` moves the tick 600 (6.2%) after 60 s; a held displacement at the ADR-0005 depth costs ~1–2 USDC and drags the 1800 s mean within 30 min; every USDC `redeem` in the window sells at the depressed spot against a floor that moved with it (~6% per 30 min held, bounded by `tvlCap`). Mitigation (default): gate the USDC sell floor on spot-vs-TWAP deviation (fall back to `redeemInKind`), and keep the ADR-0005 cap sizing. The keeper (#1779, merged) records the held price; it is not a defence. Write the analysis report the issue asks for with this severity bar. | #1793, E1, #1779 (closes: remove the "cadence from 1793" scope line) | fork test `test_recorder_heldDisplacementDragsSellFloorUnderKeeperCadence` (keeper 300 s, hold ±600 ticks, assert floor drop bounded after fix) |
| D6 | Basket dust liveness: a 1-wei RM donation blocks `removeAsset` and `emergencyUnwind` forever (`UniswapV4SwapAdapter.sol:202`, `BasketVault.sol:1121-1126,1279-1298`). Skip a sell/unwind leg whose TWAP value is below one USDC unit; let `removeAsset` accept such a balance. | E4, SR-L12 | `test_V4_dustDonationDoesNotBlockRemoveAssetOrUnwind` |
| D7 | `emergencyUnwindGuard` is never set by any stage or row (zero hits), so `emergencyUnwindWithOverride` is unusable. Add a `set-unwind-guard` govern row and a stage-12 verifier label asserting a non-zero `minUsdcOut`. Owner answers #1705 Q2 on `overrideAllowed` (default: allowed, Safe-only). | E5, #1705 Q2 | `govern.test.ts` row test; verifier fixture |
| D8 | `MorphoAdapter.setMaxExposure` is `onlyVault` and never called (`:75-77,86-93`): add an `ADMIN_ROLE` vault passthrough. Delete `IExactnessVault.allExact()` from `VaultRegistry.sol:45,516` (reverts for every vault; ADR-0010 residue) and the ADR-0010 citation in `V2MigrationIntegration.t.sol:2`. Fix `RobotMoneyVault.sol:99` NatSpec ("Irreversible" vs `restoreVault:1295`). | CS-8, F11, CS-7 | `MorphoAdapter.t.sol::test_maxExposure_settableThroughVault`; ABI gate "no allExact selector" |
| D9 | Single-leg exits carry a caller floor: route the dapp and rmpc single-vault redeem through `router.redeemFor` with `minAssetsPerLeg` (direct `vault.redeem` has no min-out, SR-M16). | E8, #1795 (contract side) | `test_redeemFor_singleLegFloorBindsOnBasketVault` |

## Workstream E — Deploy and govern tooling (`publish-contracts`)

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| E1 | **Single-vault redeploy, SHA model.** The govern row `redeploy-vault` and `verify --prior-out` accept `--core-sha` equal to `vault_redeploys[].core_sha`; verify compares the replaced vault against that SHA's artifacts and the other three against the original; record the `--prior-out` SHA in evidence; `resolveCounts` skips the frozen-counts requirement for these two paths (`cli.ts:94,377-378,447-461,479-481,517-531`, `runner.ts:1053`, `verify-stage.ts:171,179`, `verify/index.ts:216-223`, `redeploy-vault.ts:327`). | DT-2, QD-6, #1796 | `redeploy-vault.test.ts` "govern row and verify run at the redeploy SHA after a deployment at the original SHA: green, nothing paused"; "through `main()` on 8453 with no frozen file" |
| E2 | Redeploy manifest safety: save the `started` record **after** `confirmStage` (`redeploy-vault.ts:328,376-384`); a refused confirmation leaves no open record. | DT-4, #1796 | "a refused confirmation leaves no open record; the next run starts fresh" |
| E3 | Redeploy spec/tool parity: add `router.setVaultCap(new, vaultCap(old))` and a `router.vaultCap(new) == vaultCap(old)` verifier label (`redeploy-vault.ts:185-196`, `verify/index.ts:658-690`); pause before `_addAssets` in the deploy-only path (`BasketVaultDeployBase.sol:339,360`); write the runbook section and README rows the script header cites (`RedeployProtocolAssetVault.s.sol:2-3`); update `single-vault-redeploy.md:11,94,121` to name the verb, the row and `--prior-out`. Split the issue's acceptance into code (this) and operator evidence (an operator run on the Base rehearsal, recorded in `deployments/`). | F2, E7, QD-7, #1796, #1815 (closed) | `redeploy-vault.test.ts` cap-parity case; `RedeployProtocolAssetVault.t.sol` "deposit reverts between creation and first addAsset" |
| E4 | **Release gate on every broadcasting 8453 stage** (`cli.ts:473` gates only `plan`): publish, prove-control, govern and redeploy run `assertReleaseGate`; the frozen counts file must be committed and clean for plain baselines too (`release-gate.ts:109-112,159-163`). Fix runbook `:99` which already claims this. | #1816, T7 | `plan-gate.test.ts` "8453 refuses a broadcasting stage at an untagged SHA before forge"; "hand-edited frozen counts refused" |
| E5 | `--dry-run` of an 8453 sheet: `safe/signers.ts:202,237` and `runner.ts:913-921` accept the loopback simulation anvil when the sheet chain is 8453. | #1720 | existing spec, refreshed line refs |
| E6 | Read-after-write on load-balanced RPC: build on `awaitSafeNonce` (`tx.ts:345,407`, already there) for `safe.ts:241-245`, `prove-control.ts:101`, `runner.ts:671`, `redeploy-vault.ts:385,404-409`. Drop the done `tx.ts` criterion from #1723. | #1723 | retry-injected tests per site |
| E7 | prove-control log scan: retry/backoff, `--logs-rpc`, a named error for `MAX_LOG_WINDOWS` (`prove-control.ts:32-45,56`), stop at the found event; the swallowed error at `:56` becomes a refusal. | #1724 | "a failing eth_getLogs is a refusal, never an empty answer" |
| E8 | Evidence secret-scan exemption: narrow to the `sha256:` prefix and the `configHashes`/`config_hashes` keys (`evidence-check.ts:910,991,1030`); the end-of-line `0x<64hex>",` branch must not pass `"privateKey": "0x…",`. | #1689 | `evidence-check.test.ts` "a privateKey line is not exempt" |
| E9 | **Four-vault consistency (#1705) as children**, after Decisions D3: (a) stage-table schema for four vaults; (b) verifier labels per vault; (c) delete the activate-eligibility script; (d) docs gate. The parent issue stays as the tracker. | #1705 | per child |
| E10 | Clean-room addresses: `scripts/ops/test-recorder-keeper-fork.sh:18` and `RecorderKeeperDeposit.t.sol:12` read the rmAGENT and recorder addresses from `deployments/8453` manifests; suite-18 runs nightly only; `check-no-production-addresses.ts` covers Deploy 2 addresses. | QD-9 | gate lists Deploy 2 addresses |

## Workstream X — Explorer indexer, API, watchdog

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| X1 | **Discovery-tick refetch.** After `handle_log`, if a `VaultRegistered` landed in this tick, re-run `get_logs(reg_block, target, [new vaults])` and process before the cursor advances (`indexer.rs:1086-1105,1172-1174`). Make the RPC stub honour the `address` filter so the test can see it. | DI-1 | `multi_vault::vault_registered_and_deposited_in_one_tick_indexes_the_deposit` |
| X2 | Watch and heartbeat every `vaults` row regardless of status (`indexer.rs:1087-1088,1179-1187`); filter status only in product views. Old rmPROTO stops polluting `/v1/stats.total_tvl` after retirement. | DI-2, #1796 (indexer half) | `multi_vault::retired_vault_withdrawals_still_index_and_snapshot` |
| X3 | Regime feed consistency: refresh `regime_snapshots` on `AgentRevoked`, on every vote and on freshness expiry, writing a zero-count row; or compute `/v1/regime/feed` live from `committee_tilts` (`indexer.rs:2239-2243`, `db.rs:2036-2049`, `routes.rs:1747-1757`). | DI-3, #1790 follow-up | `committee_indexing::revoked_member_drops_out_of_regime_feed` |
| X4 | Vote from an unindexed member must not wedge the tick: upsert a placeholder `committee_agents` row (`active = FALSE`) on FK miss (`0014:56`, `indexer.rs:2219-2236`). Key `committee_votes` on `(chain_id, contract_address, vote_id)` like migration 0016 did for receipts. | DI-4, DI-10 | `committee_indexing::vote_from_unindexed_member_does_not_wedge_the_tick`; `votes_from_two_policy_deployments_both_persist` |
| X5 | Halt visibility: `/health` exposes the newest `indexer_runs.error` and the head-minus-cursor lag (`routes.rs:295-309`); the watchdog pages when the lag exceeds a budget instead of `touch_cursor` (`watchdog.rs:425-429`, `liveness.rs:62-71`). Volume-breach alerts go through `AlertPager`/`commit_page` and the cursor does not advance until delivery (`watchdog.rs:243-256,433-450`). | DI-5, DI-7 | `watchdog::liveness::stale_indexer_cursor_is_not_healthy`; `threshold_breach::failed_webhook_is_retried_next_cycle` |
| X6 | Catch-up cost: insert only transactions that carry watched logs (hash and index come from the log) instead of every transaction in the block with serial receipts (`rpc.rs:351-418`); treat a null receipt as an error, not `status = 0`. Then gate the six snapshot reads per #1781 and extend the budget test to four vaults. | DI-6, #1781, #1780 (input) | `catch_up_budget::event_block_fetches_only_log_bearing_transactions` |
| X7 | Reorg scope for `committee_agents` and `vaults`: reconcile `revoked_at`/`registered_at`/`registered_block` above the root in `delete_above_block`; append-only registration history. Scope `/v1/vault/snapshot/latest` by chain and vault; bind `state.chain_id` on `/v1/chains/:chain_id/contracts` (`routes.rs:311-347`). Expose the D3 exclusion claim per holder. | DI-8, DI-9, #1820 (indexer half) | `reorg_cursor_vault_status::reorged_agent_revoke_is_undone`; `endpoints::latest_snapshot_is_chain_and_vault_scoped` |
| X8 | `usdc_value` in the API uses `previewRedeem` semantics (`model.rs:475`), and the dapp actually passes `usdcValues` (`bootstrap.tsx:302-305`: today position value is always "—"). Add the PRD NAV disclosure text (`prd.md:120,363`) as a shared `NavDisclosure` component. | #1795, E8, F4 | API test; dapp "position card renders previewRedeem value and the NAV disclaimer" |
| X9 | Operator: measure the catch-up rate on the Tenderly logs endpoint with `--logs-rpc` after X6 and replace the unmeasured 1000 blocks/min target in `stage-deployment.md:55`. | #1780 | recorded number in the doc |

## Workstream U — Clients (dapp, rmpc, plugins)

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| U1 | **Swarm preflight guard.** `check-preflight.sh:79-86` greps `ic_contract_address` (rmpc key is `ic_policy_address`); guard 3 runs a nonexistent `--dry-run` and greps `AgentNotRegistered` (rmpc emits `ErrNotAllowlisted`), so it always passes. Grep the right key; replace guard 3 with a `hasRole(COMMITTEE_AGENT_ROLE)` read. | DR-1 | `run-tests.sh` executes the script against the real `rmpc` binary and `valid-config.toml` |
| U2 | **suite-11b headless deposit replay** (red daily since 2026-09-05): cast ≥ 1.8 `wallet new --json` returns `{"data":[{…}]}` → `.data[0].private_key` with a self-test over array/object/missing shapes; twin-publish step passes `govern: "true"` (rmUSDC deploys paused, so `self-check`/`deposit` refuse `ErrDepositsPaused`); pin Foundry at an exact version in `suite-11b` and `.github/actions/twin-fork/action.yml:53`, and fix `ci-suites.md:11-14`'s false "pinned to v1.7.1". | #1682, T4, DR-2 | keypair-parse self-test; a green `workflow_dispatch` run |
| U3 | rmpc router deposit gas: derive the default from `getEffectiveWeights().length` (gateway floor 400k + 1.85M per leg; `cli.rs:69,78-82`, `deposit.rs:248-253`) and refuse `--gas-limit` under the floor; fix the plugin doc "Default 350_000" (`write.md:61,178`). Dapp: scope the 2.5M `redeemGas.ts` Panic workaround to `RobotMoneyVault` targets; derive the router constant in `depositGas.ts:18-19` from `legs.length` (fails with a fifth leg). | DR-3, DR-10, #1758 | anvil fork `deposit_router_default_gas_clears_gateway_floor`; `redeem-gas-not-applied-to-basket-vaults.test.ts` |
| U4 | Dapp signing previews: preview `commitAuthorization`/`revealAuthorization` (not `authorizeAgent`) and re-render the policy preview on the reveal screen (`AuthorizeTab.tsx:77,130-187`, `useRotationState.ts:216-241`); the Withdraw tab accepts only `useVaultRegistry()` addresses as redeem targets and labels a target without a pin "UNVERIFIED" instead of "[bytecode verified]" (`DepositWithdrawTab.tsx:148,255,299,415-416`, `TxPreview.tsx:53`). | DR-4, DR-5, #1737 (part 2) | `tx-preview-fn equals signed functionName`; `withdraw-target-must-be-registered.test.tsx` |
| U5 | Dapp hardening split of #1737: (a) build-time vault/router code-hash pins and `targetCodeHashKnown` from them (`useGuardedWriteContract.ts:45-65`); (b) write-handler defence in depth and visible errors: render `write.error` and receipt status on every write tab; one reason per gatewayVerifier cause (`gatewayVerifier.ts:55-91`); (c) `mainnet-dapp.ts:43` scanner covers PK, SEED, STAGE_SHEET_PATH; mainnet-class Playwright spec. Replace the hardcoded rmUSDC unit in `formatShares` and in `vaultPreview.ts:91,104,153`, `routerPreview.ts:174,232` with `useVaultShareSymbols`, with a no-hardcode guard test. Show the D3 exclusion claim on the position card. | #1737, #1773, DR-9, #1820 (dapp half) | `deposit-tab-shows-write-refusal.test.tsx`; no-hardcode guard; code-pin unit test |
| U6 | rmpc output and refusal contract: raise `ErrPolicyExpired`, `ErrVaultDisabled`, `ErrLegUnavailable`, `ErrSlippageBoundExceeded`, `ErrWithdrawCapExceeded` where documented (`policy/mod.rs:197-223`, `rmpc-read-output-contract.md:89-133`); `get-agent` renders `null`, not `"0"`/`false`, for a failed `agents()` read (`get_agent.rs:69-117,239-244`); `withdraw-router` previews vaults, shares, floors, `assetRecipient` and gas, and requires an explicit `0` to disable `--min-assets-per-leg` (`withdraw_router.rs:160-163,304-318`); plugin skill docs list the flag and only real error names (`safety.md:25-30`). | DR-6, DR-7, DR-8 | `skill_docs_parity` extended to error names; `get_agent_failed_agents_read_renders_null`; `withdraw_router_refuses_without_floor_or_explicit_zero` |
| U7 | rmpc keystore hygiene: reject an empty passphrase, write mode 0600, wrong passphrase prints a reason on stderr (`rmpc_keystore_import.rs:52-58`, `software.rs:210-211`, `logging.rs:263-272`); the skill fence no longer writes a literal passphrase (`SKILL.md:174`). Amend `dapp-credential-decisions.md:123,133` and `configExport.ts:21-23,79-80` to the 2026-10-06 and 2026-10-14 signer decisions (software keystores sign; hardware optional). | DR-11, DR-12 | `keystore_import_rejects_empty_passphrase`; `dapp_toml_roundtrip` comment text |
| U8 | Operator: stage dapp on rm-core-stage-1 pointed at Deploy 2, naming the manifest paths, the stage overlay keys and who funds the 1 USDC deposit (the stage dapp is keyless). | #1782 | recorded in `docs/development/stage-deployment.md` |

## Workstream T — Tests and CI honesty

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| T1 | Nightly Twin rehearsal has never run: `suite-29-nightly-twin-fork.yml:50-51` grants `contents: read` only while the called suite-07 `parity` job requests `pull-requests: read` (7/7 `startup_failure` since 2026-10-07). Add the permission; add a checker that caller permissions ⊇ every called job's permissions. | T2 | `check_nightly_dispatch_list.py` sibling; one green nightly run |
| T2 | `check_cargo_test_target_coverage.py:171-199` shlex-parses `out="$(cargo test --lib …)"` as one token and credits every target. Expand `$(…)` before tokenising; add `write_seam_reverted_anvil` to suite-07 `rmpc-parity` under `cargo_test_require_executed.sh` with `RMPC_REQUIRE_ANVIL=1`. | T3 | `test_check_cargo_test_target_coverage.sh` fixture `quoted_subshell_lib_is_not_bare` |
| T3 | Deposit gas ceiling 920,000 (`gas_estimate_reality_check.rs:23-25`) with a `[gas_estimate_reality_check] deposit gasUsed=N` marker in `required_markers`; `check_no_bare_cargo_test.py:93` allow marker becomes comment-only. | #1683, T9 | guard fixtures |
| T4 | `required-checks.json` adds every unconditional push-dev job (dapp-e2e, watchdog-unit, smoke-test-guards, rmpc-unit-releases, forge-invariant-fuzz-tests, explorer-indexer-*, rmpc-e2e-*, core-stages-twin-chain); a test derives the list from the workflow tree. | T10 | `required list equals the push-dev unconditional job set` |
| T5 | Executed floors: wrap both suite-22 steps in `forge_test_require_executed.sh` with `FORGE_TEST_MIN_EXECUTED=37` and rename the job (it is plain `forge test`, no prover); raise suite-05 and suite-08 floors to the step's counts; refuse the Base-testnet adapter skip under `CI`; un-skip the three always-skipped Playwright specs or delete them (`consensus-receipts.spec.ts:52`, `number-formatting.spec.ts:99,136`). | T8, T12 | executed-floor self-tests |

## Workstream W — Docs truth sweep (do after C/D/E, before Q)

| ID | Task | Covers |
|---|---|---|
| W1 | Delete every "not yet implemented: core #1491/#1520/#1521/#1523/#1524" marker that is shipped (`prd.md:105,488,567`; `architecture.md:426,1657`; `security-model.md:115,301`; `smart-contract-invariants.md:143`; runbook `:234-235,255,257,258,453`); add a grep gate "no closed-issue not-yet-implemented markers". | #1817, F5, CS-7 |
| W2 | Audit ledger: add an SR-1012 block for the nine 2026-10-12 findings; re-disposition AZ-BSK-3, AZ-GW-3, HR-L-11 against source; `check-audit-ledger.sh` requires a row per review-file heading. Replace closed #1788 with #1820 in the issue's dependencies. | #1792, F8 |
| W3 | `smart-contract-invariants.md`: re-point the 18 "Enforced at" entries that cite deleted ADR-0010 symbols to `RobotMoneyVault`/`BasketVault` symbols and tests; register = `audits.md` + the 2026-10-12 review. Add the freeze invariants placeholder for P1. | F3 |
| W4 | `security-model.md:10,80,104-113,221,243,300` (deleted `rescueTokens`; §4.1 filled from Deploy 2; deploy path lives here; no architecture §15). `architecture.md:219-228 vs 1155-1158` (V3 vs V4 pool), `:298-300,412,1659,1687` (router on manifest; Plan #109 closed), five vs seven contracts; add a "Guardrails" heading over §8. `governance-decisions.md:11` (1790 landed). `adr/README.md:16-17` two ADR-0003; `prd.md:510,560` fee rows. | F7, F9, F10, F12, F13 |
| W5 | `redeem-gas-1482.md:103,107`: cite `BasketVaultRedeemGas.t.sol:273`, 31 units; add the `redeemInKind` note to the external guide. | #1798 |
| W6 | Phase bookkeeping: tick or remove closed rows in #1679 and #1812 (1788, 1697, 1677, 1668, 1777); #1780 lives in one phase; #1418 lists all three phases or marks 1812/1813 post-release. | #1679, #1812, #1813, #1418 |

## Workstream P — Upgradeability (last; needs the ADR first)

| ID | Task | Covers | Acceptance / test |
|---|---|---|---|
| P0 | Write and accept the upgrade ADR the plan requires (`contract-upgradeability-plan.md:170`): the pinned list of proxied contracts (default: RobotMoneyVault, the three BasketVault kinds, PortfolioRouter, VaultRegistry, RobotMoneyGateway, InvestmentCommitteePolicy, ConsensusRecommendationReceipt; adapters stay immutable and replaceable), the storage-layout tool (`forge inspect … storage-layout` diffed in CI, including library links), how immutable ceilings such as `MAX_EXIT_FEE_BPS` survive as constants, and that a freeze never pauses or alters withdrawal rights. | #1808 (spec), Decisions D4 | ADR accepted by owner |
| P1 | Stage 1 contracts: initializers, UUPS, governed `upgradeTo` through the timelock, irreversible freeze; freeze invariants in `smart-contract-invariants.md`; test that a frozen proxy keeps `redeem` and `redeemInKind` open. Runs after C1, D1, D2, D3 (same files). | #1808 | lifecycle tests; layout diff job |
| P2 | Stage 2 tooling: deployment, verification and evidence for proxies and freeze; refuse an undeclared mode or an unexpected admin slot. | #1809 | per issue |
| P3 | Stage 3 clients: bind rmpc signing to an implementation-version field in the gateway authorization digest (default mechanism; if it needs Solidity, it moves into P1); dapp, explorer and indexer disclose implementation and freeze state. | #1810 | per issue |
| P4 | Stage 4 Twin rehearsal of deploy, upgrade, freeze and rejected post-freeze upgrade, as a named nightly job. | #1811 | per issue |

## Phase Q — Final QA (only after every task above)

1. Build everything: `forge build`, `bun x tsc`, `cargo check --workspace`, dapp build.
2. Run the full required set from `scripts/ci/required-checks.json` (as extended by T4) locally or on a CI push of the branch; fix fallout in place.
3. Twin rehearsal: full publish → verify → govern (incl. one self-admin row and the redeploy row) → verify, with a software keystore owner set and, separately, with the hardware grammar.
4. Base rehearsal (operator): the single-vault redeploy procedure end to end; record evidence (E3 operator half).
5. Only then decide whether to land the branch as one merge or split it into PRs.

## Decisions (defaults the plan assumes)

| # | Question | Default used |
|---|---|---|
| D1 | Hardware signing required anywhere? | **No** (decided 2026-10-14). |
| D2 | Recorder manipulation (#1793): what loss bound is "high"? | 5% of a redeem within 30 min at the ADR-0005 depth; mitigation D5 ships regardless. |
| D3 | #1705 Q1–Q6 (emergency levers, paused-leg routing, …) | The defaults named in the issue; D7 assumes `overrideAllowed` on, Safe-only. |
| D4 | Which contracts go behind UUPS, and is the ADR written before code? | P0 list; ADR first. |
| D5 | #1810 bind or invalidate signatures on upgrade? | Bind: implementation version in the authorization digest. |
| D6 | #1683 deposit gas ceiling 920k? | Yes. |
| D7 | May the Safe renounce its timelock roles instantly (runbook `:668-669`)? | No: through the delay, and never the last proposer (B3). |
| D8 | Self-admin rows on 8453? | Twin-only stays. |
| D9 | Agent consent on authorize (D2) as an EIP-712 signature? | Yes. |
| D10 | `NAV_DEVIATION_BPS` for the V4 leg? | 400 (fee 291 + lag). |
| D11 | Apply-receipt on the mainnet test (runbook `:499`)? | No. |
| D12 | rmpc committee writes may sign with a software keystore on 8453? | Yes, under D1 (today refused per `architecture.md:1667`). |

## Issues closed or dropped by this plan

| Issue / PR | Action | Why |
|---|---|---|
| #1675 | close | tests the voting that C1 deletes |
| #1806, #1807, #1815 | close | auto-loop blockers whose targets are closed or need an operator (E3) |
| #1669 | close when B1 lands | the floor, not the PR, was the blocker; hardware grammar stays optional |
| PR 1805 | close | empty diff, "Closes #1447" |
| #1779 | close when D5 removes the "cadence from 1793" scope line | PR 1785 merged here |
| #1790 | close when A2 lands | PR 1818 merged here; PoCs flipped |
| #1787 | closed on dev already | — |

## Coverage of the 41 open issues

1418 W6 · 1447 B6 · 1645 B3/B4/B5 · 1669 B1 · 1675 closed · 1679 W6 · 1682 U2 · 1683 T3 · 1689 E8 · 1698 C1 · 1701 C2 · 1705 E9/D7 · 1720 E5 · 1723 E6 · 1724 E7 · 1737 U4/U5 · 1773 U5 · 1779 D5 · 1780 X9 · 1781 X6 · 1782 U8 · 1789 D1 · 1790 A2 · 1791 D2 · 1792 W2 · 1793 D5 · 1795 X8/D9 · 1796 E1/E2/E3/X2 · 1798 W5 · 1806 closed · 1807 closed · 1808 P0/P1 · 1809 P2 · 1810 P3 · 1811 P4 · 1812 W6 · 1813 W6 · 1815 closed · 1816 E4 · 1817 W1 · 1820 D3/X7/U5.

## Order of execution

A1–A6 → B1–B6 → C1–C3 → D1–D9 → E1–E10 → X1–X9 → U1–U8 → T1–T5 → W1–W6 → P0–P4 → Q. Within a workstream the table order is the dependency order. X, U and T do not touch contracts or `publish-contracts` and may run in parallel with D and E once A and B are done.
