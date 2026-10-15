# Prior-review coverage

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
