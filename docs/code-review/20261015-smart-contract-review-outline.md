# Smart-contract security review outline — 2026-10-15

> Draft review plan. This document defines coverage and evidence to collect; it is not a review verdict and makes no claim that a previously reported issue is open or fixed.

## Review target and scope

- Pin the exact repository, branch, commit, dirty-tree state, compiler versions, optimizer settings, linked libraries, and deployment configurations before reviewing.
- Review Solidity contracts, linked libraries, deployment and upgrade scripts, storage-layout artifacts, and contract-facing configuration needed to establish deployed behavior. Trace important calls into adapters, clients, indexers, and release tooling when they affect an on-chain invariant or authority boundary; record those seams without expanding into a general off-chain review.
- Enumerate every production contract and proxy in the target release, including vaults, basket vaults, router, gateway, registry, policies, receipt/governance contracts, adapters, oracles, tokens, timelocks, and emergency controls. Confirm which components are deployed, retired, planned, or test-only.
- Inventory every public/external entrypoint, fallback/receive path, privileged setter, external call, and linked library. Map how assets and authority can flow across contracts, including direct calls that bypass the expected client or gateway.
- List chains, addresses, implementations, roles, caps, fee/slippage settings, oracle and keeper parameters, and deployment assumptions. Separate source-level conclusions from live-chain verification.
- Treat third-party protocol internals as out of scope unless a specific integration assumption is necessary to establish a finding; state that assumption and its evidence.

## Threat model and review method

- Identify assets and claims: USDC and other underlying tokens, vault shares, adapter positions, basket assets, exclusion-recovery claims, receipts, and any signed or replay-protected operation.
- Map trusted and less-trusted actors: depositor, share owner, agent, committee member, keeper, ADMIN, EMERGENCY, Safe, proposer/canceller/executor, relayer, upgrade authority, oracle/recorder, and external venue. Record role grants and actual deployment holders separately from intended policy.
- For each boundary, trace caller identity, authorization, calldata and signatures, state transitions, external calls, token movement, emitted events, and failure behavior. Challenge assumptions about atomicity, ordering, freshness, and who can compose calls.
- Perform a manual function-by-function pass over in-scope production code and a focused review of every change since the last reviewed commit. Use static tools to generate candidates and coverage leads, then verify their claims in source and reachable execution paths.
- Turn `docs/prd.md` §12, `docs/architecture.md` §8, `docs/technical/security-model.md`, and every stable ID in `docs/technical/smart-contract-invariants.md` into a traceability matrix: invariant, implementing code, test or proof, counterexample attempted, and remaining gap. Include negative invariants and the actual custody and governance boundaries.
- Use adversarial scenarios and minimized Foundry reproductions for material claims. Include negative tests for fixes and meaningful stateful/fuzz tests for accounting, share supply, role changes, and boundary conditions. Distinguish source inspection, local reproduction, fork evidence, and live deployment evidence.
- Attempt to refute every candidate: establish prerequisites, attacker capability, impact, reachability through deployed entrypoints, mitigations, and whether an administrator action is required. Assign severity only after this analysis; deduplicate by root cause while preserving cross-contract impact.
- Run the repository-required build, tests, static analysis, storage-layout checks, and deployment/config validation. Record exact commands and results, skipped checks, failures, and environmental limits. Inspect `vm.skip`, expected-failure labels, vacuous assertions, narrow selectors, and missing harness actions before crediting formal or invariant coverage. Passing regression tests do not alone establish that a finding is fixed.

## Coverage checklist

### 1. Asset accounting and ERC-4626 behavior

- Reconcile `totalAssets`, idle balances, adapter balances, fees, pending recoveries, and excluded/quarantined positions. Verify deposits, mints, withdrawals, redeems, previews, and max functions against the same accounting model.
- Check first-depositor and donation/inflation behavior, virtual shares, rounding direction, decimal scaling, zero supply, zero NAV, partial exits, full exits, and repeated small operations.
- Check exactness and consistency of `deposit`/`mint`/`withdraw`/`redeem`, including exit fees, slippage haircuts, shutdown and pause states, and user-specified minimum proceeds.
- Verify `maxDeposit`, `maxMint`, `maxWithdraw`, and `maxRedeem` reflect caps, pauses, shutdown, available liquidity, and the actual operation's ability to succeed.
- Trace every path that changes NAV or share supply: deposits, withdrawals, donations, rebalance, emergency withdrawal, adapter removal/re-addition, exclusions, recovery, fees, and migration.

### 2. Adapters, vaults, and recovery accounting

- Verify adapter eligibility, address/code-hash pins, token and vault compatibility, caps, uniqueness, activation/deactivation, revocation, and reactivation. Ensure duplicate or stale entries cannot double-count assets or block recovery.
- Trace withdrawal failure, partial withdrawal, illiquidity, false or reverting `totalAssets`, over-delivery, under-delivery, residual idle funds, and token approval behavior. Check that accounting records actual received amounts.
- Examine `removeAdapter`, force removal, emergency exclusion, emergency withdrawal, drain-all, rebalance, and re-add sequences. Establish whether recoverable value remains attributable to the holders who owned it when excluded, including holders who exit and the zero-supply case.
- Check that pause/shutdown and quarantine gates compose correctly with deposits, keeper actions, rebalances, emergency recovery, and restoration. Confirm keepers cannot undo an emergency action or redeploy into an ineligible venue.
- Review lending integrations (Aave, Compound, Morpho, or current equivalents): NAV versus immediately withdrawable value, market stress, supply refusal, exposure caps, rounding, approvals, and venue pause behavior.

### 3. Basket assets, swaps, oracles, and economic safety

- Validate asset/pool registration, token ordering, decimals, pool identity, observation history, oracle bounds, freshness/staleness, zero or degenerate prices, and reconfiguration.
- Trace every swap and unwind path, including normal, emergency, override, and partial-failure paths. Check minimum output, maximum loss, deadlines, checked casts, return-array lengths, reentrancy, token callbacks, and atomicity across multiple legs.
- Verify deposit and redemption NAV marks against executable prices and realistic slippage. Test TWAP/spot disagreement, stale or manipulated observations, sampling cadence, ring size, missing honest updates, repeated samples, thin liquidity, fees, and arbitrage/keeper competition.
- Check per-caller and per-leg floors, router previews, unavailable legs, zero-weight and skipped legs, and whether a failure in one leg should revert or safely skip the whole operation.
- Model transaction ordering and economic feasibility: flash liquidity, transaction bundles, sandwich and back-run timing, keeper/oracle competition, fees, pool depth, protocol caps, and attacker profit versus user loss under the actual deployment settings.
- Review removal/reappearance of basket assets, rescue/sweep protections, and whether a returned token or residual position can become stranded or misattributed.

### 4. Router and multi-vault composition

- Validate registry membership, vault status and eligibility, default and user weight vectors, uniqueness, sum, ordering, stale lengths, caps, and updates during an operation.
- Trace deposits, `depositFor`, `depositTo`, withdrawals, redemptions, previews, per-leg minimums, skipped legs, unavailable legs, and partial success. Check receiver and asset attribution and prevent duplicate counting or loss of caller protections.
- Verify receipt/digest binding, nonce and replay protection, expiry/deadline behavior, weight-vector provenance, and the relation between a previewed vector and the vector used at execution.
- Check governance/application paths and all legacy routes: no bypass through an alternate setter, default vector, migration, or retired governance contract.
- Verify invariant behavior when router weights, registry status, vault implementations, or leg availability change between preview, signature, and execution; confirm previously held positions remain redeemable after a leg is retired or reweighted.

### 5. Gateway, agents, committee, and signatures

- Bind all claimed identities to `msg.sender` or verified signatures. Review registration, consent/reveal, authorization ownership, role separation, caller-supplied recipients, and policy changes.
- Check operation identifiers and replay protection across direct vault and router routes, operation-kind domains, deadlines, idempotency, cancellation, and rolling-window caps at reset boundaries.
- Review CEI and reentrancy around token transfer, share mint/burn, external calls, and gateway state. Check rollback behavior on downstream failure.
- Verify committee signal attribution, freshness, latest-vote semantics, membership, aggregation, and whether any signal can reach an authoritative governance or allocation path. Confirm retired voting surfaces are absent and receipt-based replacements enforce the intended authority.

### 6. Roles, emergency powers, governance, and timelocks

- Build a role matrix from constructors, initializers, deployment scripts, grants, revocations, and live holders. Check admin floors, role-admin relationships, accidental self-escalation, and handover completion.
- Review pause/unpause, shutdown, force removal, loss write-off, sweep/rescue, caps, fees, adapter configuration, router weights, policy changes, upgrades, and freeze powers. Evaluate each action's delay, proposer/canceller/executor roles, batching, and possible call ordering.
- Verify emergency actions preserve user exits where required and do not silently reprice recoverable assets. Resolve the intended authority boundary for writing off healthy or illiquid positions and attribute later recoveries.
- Check quorum/voting units, snapshots, threshold and delay bounds, one-voter control, proposal replay, receipt release/application semantics, and all alternate governance paths.
- Examine `ProposerFloorTimelock`, Safe module/threshold assumptions, proposer and canceller loss, open executor behavior, and emergency-key compromise or loss through the entire schedule-to-execute lifecycle.
- Exercise operational recovery procedures through the actual Safe/timelock topology where possible; do not infer deployed safety from role names or example sheets.

### 7. Upgradeability, initialization, and storage safety

- Inventory every proxy, implementation, beacon or linked library and its upgrade/freeze authority. Verify initializer protection, reinitializers, implementation locking, proxy admin paths, and deploy-time ownership handoff.
- Compare storage layouts against the pinned deployed baseline, including inheritance, packing, mappings, structs, enums, and linked-library storage assumptions. Ensure the comparison cannot be rewritten by the change under review.
- Check upgrade authorization, build provenance, implementation code identity, atomic initialization, rollback/failure behavior, post-upgrade readback, and irreversible freeze semantics.
- Verify CREATE2/address derivation, initializer front-running, UUPS compatibility and upgrade entrypoints, implementation self-locking, and that the reviewed source plus pinned compiler settings reproduce the deployed implementation bytecode. Check the compiler version against its published known-bugs list.
- Verify proxy implementation pins and code-hash checks cover the logic users actually call, are checked at the relevant transaction boundary, and have a safe rotation/retirement process.
- Inspect migrations and reinitializers for lost roles, changed accounting, stale external references, unbounded work, and compatibility with existing positions and claims.

### 8. Tokens, external calls, and Solidity-specific hazards

- Check safe token transfers, fee-on-transfer/rebasing assumptions, approval lifecycle, non-standard return values, decimals, zero-address handling, and native-token paths if present.
- Review reentrancy, checks-effects-interactions, callbacks, delegatecall/library boundaries, `tx.origin`, `block.timestamp`/block-number assumptions, signatures and domain separators, unchecked arithmetic/casts, array indexing, and denial-of-service through loops or revert propagation.
- Check chain-ID/domain separation and cross-chain replay; signature malleability or encoding collisions where signatures are used; block-builder ordering and forced token/native-asset transfers; private-state or randomness assumptions if any feature relies on them.
- Bound gas and storage growth for user exits, emergency recovery, oracle observation, exclusions, adapter and asset arrays, and governance operations at realistic maximum history sizes. Establish a workable recovery path when an external dependency reverts or runs out of gas.
- Check events against state transitions and ensure emitted values identify actual assets, recipients, agents, vaults, and amounts. Confirm off-chain consumers cannot confuse direct and routed actions or infer authority from untrusted fields.
- Review compiler version, optimizer/via-IR settings, dependencies, known inherited behavior, and any assembly or custom storage code.

### 9. Deployment truth, invariants, and residual risk

- Compare production source, deployment scripts, stage sheets, manifests, addresses, roles, caps, oracle configuration, and runbooks. Identify any difference that changes a security conclusion.
- Verify production bytecode and configuration against the reviewed commit or build manifest on every target chain. If live deployment inspection is not possible, identify the exact checks required before a release decision.
- Reconcile prior audit/review dispositions with current code and tests. Keep historical findings as immutable baseline evidence; record current status, evidence, and any remaining assumptions separately.
- State what was not reviewed, what could not be reproduced, external protocol assumptions, live-chain checks not performed, and residual risks accepted by the owner.

## Audit completeness and reporting gates

- Produce a contract/entrypoint inventory, trust-boundary and asset-flow map, invariant-to-evidence matrix, tool-output triage, and historical-finding disposition table. Mark each item covered, not applicable with a reason, or unverified; an unchecked item is a scope gap.
- Give each material finding a reproducible attack sequence and deployment-realistic impact bound. Explain attacker cost, required privilege, affected holders, liveness or loss, and any cap or time-window assumptions.
- Review every proposed fix and its new call paths, then rerun the relevant reproduction and invariant checks at the final review commit. If code changes after sign-off, assess the delta and update the verdict.
- Separate code correctness, deployment/config correctness, and operational assumptions in the final verdict. List blockers, accepted risks with an explicit decision owner, and checks still required before release.
- Use the [OWASP Smart Contract Security Verification Standard](https://scs.owasp.org/SCSVS/) and [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) as secondary checklists; explain any applicable control not covered by the project-specific review.

## Required finding record

For every candidate, record a stable ID, title, severity, affected contracts and lines at the pinned commit, assets and trust boundary, prerequisites and attacker authority, concrete call sequence, impact, reproduction/evidence, root cause, recommended change, regression test, disposition, and links to related historical findings. For refuted candidates, preserve the claim, the decisive counter-evidence, and why the proposed impact does not follow.

## Prior-review coverage register

At review close, complete one row per item below with **rechecked / fixed and verified / open / accepted / refuted / not applicable**, current evidence, and any replacement test. A prior “fixed” label is a lead to verify, not proof. Add any historical findings discovered during review and retain their original IDs.

### October 2026 contract findings

- [ ] 2026-10-12 finding 1 / SR-1012 and 2026-10-15 SEC-M-009: adapter exclusion, deposit gating, keeper behavior, exit entitlement, exclusion snapshots, recovery attribution, and residual balances.
- [ ] 2026-10-12 finding 2 and 2026-10-15 historical duplicate-adapter finding: duplicate active adapter prevention, inactive reactivation, NAV accounting, and repair/recovery behavior.
- [ ] 2026-10-12 finding 3: gateway caller-to-agent binding and committee signal aggregation/freshness; verify the retained endpoint and any authoritative consumer.
- [ ] 2026-10-12 finding 4: confirm retired RouterGovernance voting is absent; validate receipt-based replacement and role wiring.
- [ ] 2026-10-12 finding 5 / SR-1012-5 and 2026-10-15 SEC-M-010: emergency force removal, authority to write off a healthy/recoverable adapter, exit pricing, and later recovery ownership.
- [ ] 2026-10-12 finding 6: keeper rebalance after emergency withdrawal, pause/shutdown enforcement, and actual keeper role holders.
- [ ] 2026-10-12 finding 7: agent authorization consent, ownership squatting, and policy-role separation.
- [ ] 2026-10-12 finding 8 / HR-L-9: duplicate vaults in router weights, defaults, receipt application, and vector ordering.
- [ ] 2026-10-12 finding 9: reconcile audit ledger, invariants, architecture, deployment docs, and source behavior.
- [ ] 2026-10-12 V4 sampling follow-up and 2026-10-14 economics report: independently recheck assumptions, production-equivalent recorder and guards, keeper cadence, sell anchor, and residual availability/economic risk.
- [ ] 2026-10-15 SEC-M-011: paused lending venue behavior and whether an unavailable supply path blocks every deposit or distorts allocation.
- [ ] 2026-10-15 SEC-M-012: force-removed excluded adapter re-addition and whether recovered balance is credited to NAV or original claimants.
- [ ] 2026-10-15 review-security-019 / L-010: router behavior when a basket leg fails its ORA-4/economic guard.
- [ ] 2026-10-15 review-security-020 / L-011: skipped router leg carrying a non-zero per-leg floor.
- [ ] 2026-10-15 review-security-023 / L-012: receipt release versus actual application semantics and user-visible state.
- [ ] 2026-10-15 review-security-025 / L-013: lending venue refusing supply and deposit availability/failure atomicity.
- [ ] 2026-10-15 review-security-027 / L-014: partial recovery from exclusion records; avoid requiring all-at-once recovery.
- [ ] 2026-10-15 review-security-028 / L-015: Morpho exposure cap behavior and unintended deposit kill switches.

### Earlier recurring and unresolved contract findings

- [ ] May 2026 ERC-4626 first-depositor/donation inflation and virtual-share protection; verify current vault families and external-protocol donation paths.
- [ ] May 2026 idle-asset accounting and silent residue after `_routeDeposit`; confirm every vault's NAV includes idle assets and failed routing leaves correct accounting.
- [ ] May 2026 Morpho withdrawal delivery and NAV accuracy; verify returned amount against actual token receipt.
- [ ] May 2026 arbitrary adapter/vault routing authority, prototype basket public drain conditions, emergency basket unwind floors, and agent-key withdrawal limits.
- [ ] June 2026 basket mint haircut bypass; oracle zero/degenerate values and stale-price handling; RWA emergency-unwind freshness; exact ERC-4626 withdraw/preview behavior.
- [ ] June 2026 `maxWithdraw`/`maxRedeem` under pause, proportional-pull sweep/liquidity bounds, active-adapter allowlist revocation, and keeper/withdrawal denial of service.
- [ ] June 2026 swap deadline effectiveness, Uniswap V4 integer narrowing, Aerodrome/router return-array validation, and basket asset removal/reappearance/rescue behavior.
- [ ] June 2026 rolling-window cap burst at anchor reset; payment ID operation-kind domains; gateway share source/receiver attribution; CEI and replay/idempotency boundaries.
- [ ] June 2026 governance voting snapshot and admin bypass assumptions; emergency override floors and who can change them; ensure retired governance or accepted risks are still accurately described.
- [ ] Earlier router uniqueness finding HR-L-9 and all prior adapter duplication/accounting reports; verify fixes on the exact target contracts, not similarly named vault families.
- [ ] Open or partially dispositioned audit-ledger groups named by the October 12 review: SR-H4, FS-VLT-10/21/22/23/27, HR-I-1/2/3/7, FORCEREMOVE-001, DC-0606-DEFER GOV-003, AC-008, and SR-0612-OPEN. Resolve whether each is in scope, superseded, still open, or accepted, with evidence.

### June 12, 2026 full Solidity finding set

Re-read every entry in the source report, including entries later marked fixed or accepted. Record a current disposition and evidence for each ID; do not use this list as a claim that any historical status still applies. The June 12 report covered the gateway, vaults, router/governance, registry, adapters, and devnet stubs.

- [ ] High: SR-H1 (gateway share-donation DoS), SR-H3 (`redeemFor` confused deputy), SR-H4 (reverting adapter `totalAssets` blocks vault and removal), SR-H6 (TWAP observation failure blocks basket operations and emergency exits).
- [ ] Medium: SR-M1 (commitment overwrite), SR-M2 (authorization front-run/ownership), SR-M3 (rolling-window cap burst), SR-M4 (minimum execution delay), SR-M5 (vote snapshot), SR-M6 (router custody donation DoS), SR-M7 (stale weight vector/paused vault blocks deposits), SR-M8 (Chronicle zero or out-of-range price), SR-M9 (exit-fee max-withdraw inconsistency), SR-M10 (rebalance bypasses per-call bound/emergency withdrawal), SR-M11 (unswappable asset blocks redemptions), SR-M12 (inactive asset consumes max-assets slot), SR-M13 (ERC-4626 max-view violations), SR-M14 (redeem reports preview floor rather than actual payout), SR-M15 (duplicate basket assets/adapters double-count NAV), SR-M16 (sandwichable basket entry/exit and deadline), SR-M17 (emergency override still constrained by TWAP floor), SR-M18 (emergency unwind pauses redemptions), SR-M19 (Aerodrome execution/pricing mismatch).
- [ ] Low: SR-L1 (rescue self-rescue guard regression), SR-L2 (gateway share-owner inconsistency), SR-L3 (max-withdraw views while paused), SR-L4 (proportional-pull rounding remainder/shortfall), SR-L5 (irreversible emergency shutdown), SR-L6 (allowlist revocation blocks deposits/rebalance), SR-L7 (zero slippage setting bricks swaps), SR-L8 (inactive basket asset rescue), SR-L9 (registry asset/ERC-4626 mismatch), SR-L10 (Uniswap V4 narrowing casts), SR-L11 (Morpho withdraw-all sentinel), SR-L12 (dust donation blocks asset removal), SR-L13 (router redemption lacks caller floor), SR-L14 (execute does not revalidate eligibility and stuck proposals).
- [ ] Compare the June 12 remediation-drift table and the June 18 Layer 1 table with current code and tests, especially regressions and claims that a fix existed only on an unmerged branch.

### June 18, 2026 residual risks explicitly left open or partial

- [ ] Reassess L-3 irreversible `shutdownVault` under EMERGENCY authority; L-8 `redeemFor` without a caller floor/deadline; L-9 duplicate router weights; L-10 loss of the last self-administered admin; and L-11 arbitrary-recipient `rescueUsdc`.
- [ ] Reassess I-1 unbounded inactive adapter-array growth; I-3 Morpho withdraw-all sentinel and false-positive test; I-4 RmToken approval race/infinite allowance (including accepted devnet-only scope); I-5 chain guard on `UniswapV3PoolSlot0Stub`; I-6 fee-on-transfer balance-delta handling in the V4 adapter; I-7 registry asset cross-check; and I-8 unbounded AgentPolicy arrays.
- [ ] Review the June 18 table’s remaining informational items, including adapter-array gas growth, exit-fee dust rounding, token approval semantics, test-only reachability, and scaling documentation. Record current status even if the issue remains intentionally accepted.
- [ ] For the June 9 audit findings H-1, M-1 through M-10, L-1 through L-17, and I-1 through I-10, verify the June 18 remediation evidence still holds at today’s target commit; include the especially important admin-controlled weight-setting bypass (M-10) and its current governance model.

### Cross-report inventory requirement

- [ ] Inventory all contract-relevant findings in every earlier `docs/code-review` snapshot, including the May 8, May 9, May 18, June 2, June 6, June 7, June 9, June 12, June 18, June 19, June 23, July 28, October 12, October 14, and October 15 reports. Add a coverage row for any contract claim not represented above, preserve its original identifier, and explain why it is out of scope if it is not rechecked. Also inspect `docs/audits.md` for unresolved or partially closed contract findings.

## Review closeout

- [ ] Summarize target commit, exact scope, method, commands, and evidence level.
- [ ] Publish findings with severity and disposition; cross-link prior IDs and update the audit ledger only when the evidence supports it.
- [ ] List regression coverage, failed/skipped checks, deployment-specific assumptions, and residual risks.
- [ ] State merge/release blockers and required follow-up owners without treating intended remediation or documentation alone as proof.
