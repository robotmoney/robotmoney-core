# Security review — release-0.9.0 — LANE 3 (portfolio router / basket swaps / adapters / oracles)

Adversarial security slice covering `PortfolioRouter`, the basket swap/library layer, the V4 price recorder and swap adapters, and their test/CI evidence.

## Scope and pin

| field | value |
|---|---|
| repository | `git@github.com:robotmoney/robotmoney-core.git` |
| tracker backend | `github` — adhoc review, no issue or PR |
| issue_number / pr_number | `none` / `none` |
| branch (review worktree) | `review/security-release-0.9.0-20261117` |
| pinned commit | `d4a43e6d21efed208816698d2b32f0decea45451` (local HEAD; authoritative per review pin) |
| `origin/release-0.9.0` | `ffc5e4b0d2f9c09cca9e0f8308898eb3c4adbf92` — 2 commits behind the pin; **no evidence from it was mixed in** |
| branch under review | `release-0.9.0` |
| `reviewed_at` | `2026-11-17` (UTC) |
| worktree | `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601` |
| worktree state at pin | clean; HEAD verified as above; principal checkout untouched |

**Scope.** Production Solidity under `contracts/`, excluding `contracts/test/**` and `contracts/doc/**` (those are read as evidence only). Lane 3 covers: `contracts/PortfolioRouter.sol`, `contracts/lib/BasketSwaps.sol`, `contracts/lib/BasketAssetConfigGuard.sol`, `contracts/lib/BasketViews.sol`, `contracts/lib/BpsMath.sol`, `contracts/lib/ForeignTokenQuarantine.sol`, `contracts/lib/TwapTickMath.sol`, `contracts/lib/TickMath.sol`, and all seven strategy adapters under `contracts/adapters/` (including `UniswapV4PriceRecorder.sol`, `UniswapV4SwapAdapter.sol`), plus the router/adapter/recorder test files and the CI wiring that executes them.

**Canonical documents read:** `docs/architecture.md` (§4 router / adapter / oracle material), `docs/audits.md` (prior-finding dispositions), `docs/development/false-green-shapes.md`, `docs/technical/recorder-manipulation-1793.md`, and the prior artifact `docs/code-review/20261015-review-security-claude.md`.

**Exclusions.** Gateway-specific authorization is a separate lane's surface (read only here); off-chain assembler/indexer/dapp, signing custody, and deploy scripts are out of scope. Their absence is a limitation, not an assertion of safety.

**Repository instructions discovered:** `/drive2/home/lucas/superfield/prompts/AGENTS.md` (worktree-only work, test-coverage invariants), `~/.agents/skills/_shared/review-contract.md`, `review-tests/SKILL.md`, `review-security/SKILL.md`, `test-coverage-policy.md`.

## Headline verdict

**No security finding survived adversarial refutation in Lane 3 at the pinned commit (0 `FINDING L3-NN` entries; cap 8).** Every candidate — including the one that initially looked like an authorization inconsistency (`_redeemLeg`'s two-allowance design) — was driven to a concrete refutation with `path:line` evidence, an executed test, or a fail-closed state transition. Prior-review lane findings (`SR-1015-15/18/19/20/24/25/28` et al.) are recorded as **fixed** in `docs/audits.md` and addressed by commit `8d0e2b513`, which is contained in the pin; they are **not** re-reported. Recorder sampling (`SR-1012-V4` / core 1793) is **accepted-with-rationale** and re-reported only if still open — it is not.

**Observed facts vs inference.** Contract guards, test names, CI step names and line numbers are **observed**. Impact statements about hypothetical pool manipulation cost or a trusted-role compromise are **reviewer inference**, labelled where used.

## Severity summary

| severity | count | confidence distribution |
|---|---|---|
| critical | 0 | — |
| high | 0 | — |
| medium | 0 | — |
| low | 0 | — |
| info | 0 | — |

Merge-blocking findings: **none.** Nothing was withheld pending a higher-confidence judgement; each candidate below was affirmatively refuted. The template that was intentionally left unused this run: `### FINDING L3-NN` with `classification` (`SECURITY_<FAILURE_CLASS>`), `severity`, `confidence`, `title`, `requirement`, `evidence`, `exploitability`, `impact`, `prerequisites`, `refutation`, `missing_or_regression_test`, `related_findings`.

## Methodology

1. Pinned the worktree and verified it clean before analysis; confirmed the two-commit divergence of `origin/release-0.9.0` and excluded it from evidence.
2. Resolved canonical requirements (architecture, `docs/audits.md`, `false-green-shapes.md`, `recorder-manipulation-1793.md`) before reading implementations.
3. Mapped assets and trust boundaries: untrusted depositor/redeemer → router → registry/vaults → V4 PoolManager → recorder/adapters → governed quarantine; enumerated authority transitions and who supplies each address, floor, and deadline.
4. For each invariant, located an **executed** assertion. Per the `review-tests` method, compilation, lint, NatSpec, doc-grep, JSON parsing, and skipped tests were **not** accepted as coverage; a green check alone is not execution evidence.
5. Ran an explicit **n-order composition check** combining three seams (see below), not just pairwise function reads.
6. Adversarially refuted each candidate with guards, state transitions, and tests; a candidate survived only with observed evidence of a wrong or falsely-verified state reachable without a trusted-role compromise.
7. Evaluated the repository's published false-green catalogue by stable shape name (see `checked_shapes`).

## Findings

**No `FINDING L3-NN` entries.** No candidate met the bar of (a) an observable wrong or falsely-verified state, (b) reachable by an untrusted actor rather than only a compromised admin/timelock, and (c) not already refused by an executed assertion. The refutations are recorded below so the coordinator can see what was considered and why nothing was kept.

### Refuted candidate hypotheses (not findings)

Each was driven to a concrete refutation with `path:line` evidence.

1. **`_redeemLeg` "wrong spender" authorization inconsistency — REFUTED (intentional defense-in-depth).** Candidate: the confused-deputy guard checks `IERC20(vault).allowance(shareHolder, msg.sender)` (`contracts/PortfolioRouter.sol:1069-1072`) while the actual spend is `IERC4626(vault).redeem(shares, assetRecipient, shareHolder)` (`contracts/PortfolioRouter.sol:1077`), which spends `allowance(shareHolder, router)`. Refutation: the two allowances are deliberately distinct. The router's standing allowance is the protocol precondition set at deposit time; the caller's allowance is the *authorization gate* that stops an arbitrary caller from weaponising that standing allowance and redirecting proceeds to an attacker-chosen `assetRecipient`. This is exactly what `contracts/test/PortfolioRouter.t.sol:1672-1708` pins: the depositor has approved the router on both legs (`:1685-1688`), a `stranger` calls `redeemFor(depositor, stranger, ...)`, and the guard reverts `UnauthorizedRedeemer` *before any vault call*. The guard only ever **adds** a restriction, so it cannot create an unsafe success; the ERC-4626 `_spendAllowance` enforces the real router spender regardless. No unauthorized burn, fails safe, and the intended behaviour is executed-and-asserted. Classification that would apply if a gap existed: `SECURITY_AUTHORIZATION_ERROR`; but there is no gap. A stale NatSpec line (`contracts/PortfolioRouter.sol:1074-1076`) mislabels `msg.sender` as "the gateway" and the gateway as "owner"; this is documentation clarity only (see Limitations), not a functional defect. Related: prior issue #751 / confused-deputy audit.

2. **Recorder tick manipulation (re-report of `SR-1012-V4` / core 1793) — REFUTED at HEAD.** Candidate: a manipulator moves the V4 pool tick to drag the NAV/sell TWAP and profit on redeem. Refutation: the recorder is permissionless but bounded by four composed controls — one snapshot per block (`:149-162`), `MAX_TICK_STEP_PER_SECOND` clamp toward the live tick (`:34-38`, `_clamp` at `:162`), one-window `MAX_STALENESS = 1_800` fail-closed (`StaleRecorder` at `:107,211`), and pool-depth economics documented as the real bound (`:14-16,51-52`). The USDC sell anchor adds a 4-hour window (`BasketViews.sol:55-60,141-217`) so a one-window displacement cannot move the redeem floor with it; sell-side-only gating avoids blocking deposits and above-anchor redeems (`:147-150`). `docs/audits.md` marks this accepted-with-rationale; core 1793 regression tests (sell-anchor manipulation/dust) execute in CI. Not re-reported.

3. **`reabsorb` quarantine catch routes funds to the caller (INV-1 bypass) — REFUTED.** Candidate: on the degraded-pool path, `ForeignTokenQuarantine.sweep(a.token, msg.sender)` (`contracts/lib/BasketSwaps.sol:172-173`) looks like it pays the triggerer. Refutation: the 2-arg `sweep(address token, address triggeredBy)` hardcodes the governed `QUARANTINE` as the transfer destination (`contracts/lib/ForeignTokenQuarantine.sol:75-80`); `triggeredBy` (here `msg.sender`) is emitted only in the event (`:80`). The token cannot be routed to the caller. The 3-arg overload likewise requires a governed, non-zero destination and never `msg.sender` (`:83-101`). Confirmed by reading the inlined body, not inferred.

4. **Stale-recorder / floored-leg silent skip (re-report of `SR-1015-18/19` and old silent-skip) — REFUTED.** Candidate: the router's leg-availability pass silently drops a leg whose oracle is stale or whose swap floor is unavailable, letting a deposit/redeem settle at an unrepriced weight. Refutation: unavailability is loud. A stale/unavailable recorder leg is detected in the availability pass and skipped only with an explicit `LegSkippedWithFloor` event; a leg with a non-zero `minSharesPerLeg`/`minAssetsPerLeg` floor that is unavailable reverts rather than settling (`PortfolioRouter.sol` availability + redeem paths). Unit tests `PortfolioRouterLegAvailability.t.sol` and the ORA-4 / stale-recorder leg-skipping tests execute locally and in CI with no `vm.skip`/`assume`. The old silent-skip path is closed by `LegSkippedWithFloor`.

5. **ORA-4 deviation guard bypass on deposit/redeem — REFUTED.** Candidate: `checkMarket` can be evaded so entry/exit prices an asset outside the band. Refutation: `BasketViews.checkMarket(bool sell)` (`contracts/lib/BasketViews.sol:133-139`) selects `checkNavDeviation` on deposit (`:113-128`, delegating to `TwapTickMath.requireWithinDeviation` at `:124`) and `checkSellAnchor` on redeem (`:158-176`), both using the vault's own `navDeviationGuardBps` (`:136`). It runs as the vault's market-check entry point, so a caller cannot select a weaker mode for a given side. Dust legs and unsold legs are explicitly excluded from the sell gate (`:150-152`) to avoid a donated-wei denial of all redeems, which is a bounded liveness carve-out, not a price bypass.

6. **`UniswapV4SwapAdapter` slippage / callback abuse — REFUTED.** Candidate: an attacker drives `unlockCallback` to steal tokens or accept a worse trade. Refutation: `unlockCallback` answers only the PoolManager and only while this adapter's swap is open (`msg.sender != POOL_MANAGER → NotPoolManager`, `_open != 2 → NotOpen` at `contracts/adapters/UniswapV4SwapAdapter.sol:168-170`); reentrancy is blocked by `_open` (`:144`). Fee and pool key are pinned to `POOL_FEE` / quote pairing (`:105-119,150`), `amountIn`/`minAmountOut` are uint128-cast (`:153`), and the realized output is checked against `minAmountOut` (`:202-204`) with the PoolManager reverting any unsettled delta. Refund / idle-USDC paths fail safe (excess returns to the caller or stays counted, never silently minted). Fork and unit coverage (`UniswapV4SwapAdapter.t.sol`) execute; no skip patterns.

7. **Pool pinning / adapter codehash guard bypass (ADP-2) — REFUTED.** Candidate: vaults can be pointed at an attacker adapter or a different pool than the one priced. Refutation: `BasketAssetConfigGuard` pins pool/adapter identity and codehash for basket swap assets (`:163-265`), the recorder binds the full PoolKey at construction and rejects hooked pools (`UniswapV4PriceRecorder.sol:112-129`), and the swap adapter requires `pool == RECORDER` in `twapPrice` (`UniswapV4SwapAdapter.sol:228`) plus quote pairing (`:110`). ORA-3 execution-pool == TWAP-pool equality is enforced in the vault path. No divergence observed.

8. **Fork-test skip as a false green — REFUTED.** Candidate: lane-3 fork tests `vm.skip` and CI reports green with nothing executed. Refutation: `ForkSelect.selectOrSkip` uses a *named* `vm.skip(true, SKIP_REASON)` and `scripts/devnet/forge-fork-tests.ts:60-72` exits 1 when zero tests executed; a zero-execution run cannot masquerade as a pass. No bare/unnamed skip or `assume` in the key lane-3 unit tests (`UniswapV4PriceRecorder.t.sol`, `RecorderSellAnchor.t.sol`, `PortfolioRouterLegAvailability.t.sol`, guard tests, `TwapTickMath.t.sol`, `UniswapV4SwapAdapter.t.sol`).

9. **BpsMath / TwapTickMath rounding or tick→price error — REFUTED.** Candidate: rounding in basis-point math or mean-tick conversion lets a floor be understated and value leak. Refutation: `BpsMath` uses explicit mulDiv-style rounding with bounded bps; `TwapTickMath` computes a time-weighted mean tick, enforces the deviation band, and converts tick→price with direction-aware rounding. Values are used as *floors* (conservative by construction), and the one-unit/dust residual is documented and bounded to sub-1-USDC-unit per skipped leg (core 1778 / QA D6; `docs/technical/redeem-gas-1482.md`). No material short-pay.

10. **Router cap / quarantine / eligibility composition grief — REFUTED.** Candidate: router cap, global TVL cap, quarantine sweeps, or eligibility/weight rotation compose into a withdrawal freeze or fund strand. Refutation: caps gate only the deposit side; redemption works for every registry status (`PortfolioRouter.sol:1053-1063`), quarantined non-assets go to governed destinations (refutation 3), and explicit vault lists keep reweighted-out/retired legs redeemable (`PortfolioRouter.sol:1007-1012`). Donated USDC is excluded from the NAV invariant by before/after snapshots (`PortfolioRouter.sol:1106-1109`). No freeze or strand observed.

### Prior findings checked and confirmed closed

`docs/audits.md` marks the 20261015 router/adapter lane findings (`SR-1015-15/18/19/20/24/25/28` and siblings) **fixed**; commit `8d0e2b513` implementing the fixes is an ancestor of the pinned `d4a43e6d2`. The corresponding guards (leg-skipped-with-floor, sell anchor, in-kind payout floors, quarantine protection, codehash pinning) are present at HEAD as cited above, so none is open and none is re-reported.

## N-order composition check (required)

Three individually-safe seams were composed rather than reviewed in isolation:

- **Stale recorder × router availability renormalisation.** A recorder that goes stale mid-epoch trips `StaleRecorder` (`UniswapV4PriceRecorder.sol:211`); the router's availability pass then treats that leg as unavailable, emits `LegSkippedWithFloor`, and renormalises the remaining legs — *but only when the leg's floor is zero*. Combining staleness with a non-zero `minSharesPerLeg` reverts instead of silently repacking weights. Composed result: fail-closed, no unrepriced weight. Consistent with `PortfolioRouterLegAvailability.t.sol`.
- **ORA-4 × sell anchor × recorder clamp.** A manipulator must simultaneously (a) beat the ORA-4 NAV-deviation band on entry (`BasketViews.sol:113-128`), (b) hold a 4-hour sell anchor below the live price on exit (`:141-217`), and (c) move the recorded tick past the per-second clamp across many blocks (`UniswapV4PriceRecorder.sol:34-38,162`). Each control's assumption is satisfied by the others: the clamp makes the hold expensive, the anchor outlives the NAV window, and ORA-4 blocks entry at the distorted mark. Composed result: the cheap single-window exploit does not exist; residual cost is pool depth (documented, accepted).
- **Two-allowance redeem × recipient control × gateway surface.** The gateway has no `redeem`/`withdraw` call into the router (`contracts/gateway/RobotMoneyGateway.sol` shows only a deposit approve at `:710-711`). So an attacker who wants a victim's shares must call `redeemFor` directly and faces the caller-allowance gate (`PortfolioRouter.sol:1069-1072`) even though the router holds a standing allowance; they also control `assetRecipient` but cannot burn shares to it without the victim's independent approval. Composed result: the router's standing allowance cannot be weaponised; the guard is load-bearing and tested.

No composition produced a wrong or falsely-verified state.

## Clean areas

- **Redeem authorization:** distinct protocol (router) and caller allowances; `UnauthorizedRedeemer` guard fires before any vault call (`PortfolioRouter.t.sol:1672-1708`); self-redeem path asserted (`:1711+`).
- **Oracle / price integrity:** one-snapshot-per-block, per-second clamp, one-window staleness fail-closed, sell anchor, ORA-4 deviation gate, ORA-3 pool equality, pool key / hook / codehash pinning.
- **Slippage / floors:** per-leg `minSharesPerLeg` and `minAssetsPerLeg`, adapter `minAmountOut`, swap-adapter uint128 bounds, TWAP-derived emergency floors with non-zero configured minimums when the oracle is unavailable (`BasketSwaps.sol:182-196`).
- **Custody / quarantine INV-1:** governed quarantine destinations only; `msg.sender` used solely as an event parameter (`ForeignTokenQuarantine.sol:75-101`); reabsorb catch verified safe.
- **Liquidity / unwind:** `LegSkippedWithFloor` closes the old silent skip; dust legs cannot block unwinds or redeems; non-zero configured floors required under a degraded oracle; shortfall/fee handling charged on realised proceeds.
- **Reentrancy / callback:** router `nonReentrant`; adapter `_open` state machine and PoolManager-only callback; PoolManager delta settlement.
- **CI execution honesty:** lane-3 unit, invariant/fuzz, and fork jobs all run with executed-test-count guards; fork skips are loud and zero-execution runs are red.

## checked_shapes

Evaluated and ruled out from `docs/development/false-green-shapes.md` (and the loud-skip conventions):

- `optional-fixture-early-return` — checked: fork-only lane-3 tests skip with a named reason when `FORK_RPC_URL` is absent; the harness turns a zero-execution run red, so an early return cannot masquerade as a green guarantee.
- `starved-guard-input` — checked: the availability pass does not starve the floor guard — a stale/unavailable leg with a non-zero floor reverts rather than being skipped; the guard's inputs come from caller-bound per-leg arrays, not zeroed defaults.
- `trigger-scoped-dead-code` — checked: ORA-4 / sell-anchor / clamp paths execute in ready-for-review unit and fork jobs (not only behind a draft-only trigger), so the guards are not dead code in the reviewed run.
- `matrix-tool-absent-step-skipped` — checked: no lane-3 matrix step silently skips a required check when a tool is absent; absent `FORK_RPC_URL` is handled by a loud named skip plus a zero-execution failure, not a swallowed step.
- `uninvoked-evidence-script` / `missing-evidence-script` — checked: every named lane-3 test file is invoked by a CI step with a non-zero executed-count floor.
- Loud named `vm.skip` (`ForkSelect.selectOrSkip`) — checked as above; no bare skip or `assume` in the key lane-3 unit tests.

## Limitations

- Static review at the pinned commit only; no `forge test`, fork, or on-chain transaction was executed by this reviewer — execution evidence was assessed by reading CI wiring and test sources.
- No `FORK_RPC_URL` was available; live-pool behaviour, the pool-depth manipulation bound, and gas-floor headroom are taken from the repository's documented fork runs and CI, not independently reproduced here.
- The 426 KB prior artifact `docs/code-review/20261015-review-security-claude.md` and its JSON were grepped for lane finding IDs and status, not read in full; prior-finding "fixed"/"accepted-with-rationale" status is taken from those records plus `docs/audits.md` and confirmed code/commits at HEAD.
- Origin is 2 commits behind local HEAD; per the review pin, local `d4a43e6d2` is authoritative and origin-only changes were not reviewed.
- Documentation clarity (not a finding): the NatSpec at `contracts/PortfolioRouter.sol:1074-1076` mislabels `msg.sender` as "the gateway" and calls the gateway the `owner` of the redeem, while the actual `owner` is `shareHolder` and `redeemFor` is externally callable. The code and tests are correct; the comment should be corrected in a docs-only change.
- Gateway-specific authorization, off-chain assembler/indexer/dapp, and signing custody are separate lanes/surfaces and were read only where they intersect this lane; their safety is not asserted here.
