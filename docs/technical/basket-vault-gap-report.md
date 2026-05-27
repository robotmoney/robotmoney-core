# Basket Vault Gap Report

**Scout issue:** #324  
**Date:** 2026-05-15  
**Vaults audited:** `ProtocolAssetVault` (rmPROTO), `AgentTokenVault` (rmAGENT)  
**Prototype source:** `contracts/vaults/BasketVault.sol`, `contracts/vaults/ProtocolAssetVault.sol`, `contracts/vaults/AgentTokenVault.sol`  
**Canonical docs:** `docs/prd.md` §11.2, §11.3; `docs/development/open-questions.md` §3.15; `docs/architecture.md` §4.1, §4.4, §8, §10

---

## Purpose

This report maps each router-eligibility requirement against the current
prototype for both basket vault types. Each requirement is rated:

- **Met** — prototype satisfies it without further work.
- **Gap (blocks eligibility)** — must be resolved before any ADR approves
  router registration.
- **Gap (optional)** — quality/disclosure gap that does not block
  router registration but should be resolved before production.

No contract code is changed by this scout.

---

## Router Eligibility Checklist

The canonical eligibility bar is established by `docs/architecture.md` §4.4
and §8:

1. Synchronous redemption in a single transaction.
2. Tamper-resistant price oracle (not slot0 / spot price).
3. Slippage bounds surface before signing.
4. Rebalancing model specified (trigger, target, cost disclosure).
5. ERC-4626 conformance (standard `deposit`, `redeem`, `previewRedeem`
   semantics).
6. Caps enforced before accepting deposits (TVL + per-deposit).
7. Pause and emergency unwind path present.
8. No direct adapter/venue exposure to depositors.

For `AgentTokenVault` only:

9. Shortlist governance mechanism resolved (admin-curated prototype is
   not production-ready per `docs/development/open-questions.md` §1.3, §1.4, §3.15).

---

## ProtocolAssetVault (rmPROTO)

### Eligibility requirement 1 — Synchronous redemption

| | |
|---|---|
| **What the prototype does** | `_withdraw` swaps each active basket asset back to USDC via `SWAP_ROUTER.exactInputSingle` in a single transaction. If any single swap reverts (e.g., insufficient liquidity, slippage exceeded), the entire withdrawal reverts. |
| **What is missing** | Synchronous withdrawal is structurally in place but is not guaranteed — it is conditional on Uniswap V3 pool liquidity at execution time. Under low-liquidity conditions the `amountOutMinimum` guard reverts the transaction, leaving the depositor unable to exit without admin intervention or a slippage parameter change. No fallback path (e.g., graceful partial-fill, emergency USDC reserve) is specified. The architecture (`docs/architecture.md` §4.4) requires the vault to be "excluded until the product promise changes" if synchronous redemption cannot be reliably fulfilled. |
| **Gap rating** | **Gap — blocks eligibility** |
| **ADR required** | Yes. The ADR must resolve: (a) acceptable liquidity proof for each basket token before router registration, (b) whether a minimum-liquidity check is gated at deposit or at router-eligibility review, and (c) the slippage bound that defines the acceptable worst-case exit. |

### Eligibility requirement 2 — Tamper-resistant price oracle

| | |
|---|---|
| **What the prototype does** | `BasketVault._quote` reads `IUniswapV3Pool(pool).slot0()` to derive the current sqrtPriceX96 and converts token amounts to USDC. This is the Uniswap V3 *instantaneous* price, which can be manipulated by a flash-loan or large block-time trade. The prototype code includes a comment: `// PROTOTYPE: slot0 is manipulable. Replace with a TWAP via observe() before production.` |
| **What is missing** | A time-weighted average price (TWAP) reading via `IUniswapV3Pool.observe()`, replacing slot0 entirely. The TWAP window, freshness tolerance, and the secondary oracle source (if any) must be specified. `docs/prd.md` §11.2 states: "This vault requires a TWAP oracle replacing the current slot0 pricing … before it is Router-eligible." |
| **Gap rating** | **Gap — blocks eligibility** |
| **ADR required** | Yes. See ADR outline: TWAP Oracle Source Decision (Appendix A). |

### Eligibility requirement 3 — Slippage bounds surface before signing

| | |
|---|---|
| **What the prototype does** | `maxSlippageBps` is an admin-configured parameter capped at 500 bps (5%). The `_routeDeposit` and `_sellProportional` helpers compute `amountOutMinimum` as spot-price * (1 - slippageBps/10000). This bound is enforced at swap execution but is **not surfaced** in any view function a user or the Portfolio Router can call before signing. |
| **What is missing** | A `previewDeposit`/`previewRedeem` path that exposes the worst-case net USDC out, accounting for slippage. `docs/architecture.md` §8 requires that "Any router leg with slippage, oracle, liquidity, or quote-freshness risk must surface bounds before signing." The current `previewRedeem` in `BasketVault` applies only the exit fee; it does not account for swap slippage, so the previewed amount is systematically optimistic. |
| **Gap rating** | **Gap — blocks eligibility** |
| **ADR required** | Resolved within the TWAP ADR; slippage-adjusted preview function is a required output. |

### Eligibility requirement 4 — Rebalancing model

| | |
|---|---|
| **What the prototype does** | New deposits are routed equally across active assets at deposit time. No `rebalance()` function exists. When assets are added or removed via `addAsset`/`removeAsset`, existing depositors' proportional holdings are not adjusted. |
| **What is missing** | A specified rebalancing model covering trigger (admin-initiated, keeper, or depositor-self-service), target weights (equal-weight or governed vector), cost disclosure (slippage preview before execution), and impact on existing shareholders. `docs/development/open-questions.md` §3.15 documents all three open sub-questions and explicitly states this must be resolved before the agent-token vault can meet the transparent-performance requirement. The same gap applies to ProtocolAssetVault once new assets are added over time. |
| **Gap rating** | **Gap — blocks eligibility** |
| **ADR required** | Yes. See ADR outline: Rebalancing Model Decision (Appendix B). |

### Eligibility requirement 5 — ERC-4626 conformance

| | |
|---|---|
| **What the prototype does** | `BasketVault` extends OpenZeppelin `ERC4626`. The `_decimalsOffset` of 18 mitigates inflation attacks. `previewRedeem` accounts for exit fee. `_withdraw` is overridden to drive swap logic; it ignores the `assets` parameter, substituting actual swap proceeds. |
| **What is missing** | The deviation in `_withdraw` (ignoring the `assets` parameter and producing a different net amount than `previewRedeem`) breaks the ERC-4626 invariant `redeem(s, r, o)` must return at least `previewRedeem(s)` USDC. Under slippage the actual USDC received is less. This is noted in the inline comment (`Actual net may be lower than previewRedeem by up to maxSlippageBps`) but is not disclosed to the router. The property-based conformance test suite added in #323 may flag this deviation if extended to basket vaults. |
| **Gap rating** | **Gap — blocks eligibility** (ERC-4626 guarantee is part of the synchronous-redemption product promise) |
| **ADR required** | Resolved within the TWAP + slippage-preview ADR. |

### Eligibility requirement 6 — Caps enforced before deposits

| | |
|---|---|
| **What the prototype does** | `_deposit` checks `usdcAmount > perDepositCap` and `totalAssets() + usdcAmount > tvlCap` before swapping. |
| **What is missing** | The `totalAssets()` check uses slot0 pricing, so cap enforcement can be gamed by temporarily distorting the slot0 price. Once TWAP is implemented, caps should read NAV from TWAP-based `totalAssets`. This is a dependency of the oracle gap, not an independent gap. |
| **Gap rating** | **Dependent gap** (resolved when oracle gap is resolved) |

### Eligibility requirement 7 — Pause and emergency unwind

| | |
|---|---|
| **What the prototype does** | `pause()` / `unpause()`, guarded `emergencyUnwind()`, explicit `emergencyUnwindWithOverride(tokens)`, and `shutdownVault()` are all present with appropriate role guards. Operators configure each basket token with `setEmergencyUnwindGuard(token, minUsdcOut, overrideAllowed)` before incident use. The default unwind passes the configured `minUsdcOut` to the router and reverts when the emergency swap cannot satisfy that floor. |
| **What is missing** | Nothing critical. If a distressed exit must accept less than the configured guard, the token must first have `overrideAllowed=true`; the emergency caller then uses `emergencyUnwindWithOverride(tokens)`, which emits `EmergencyUnwindOverrideUsed` before the zero-minimum swap so indexers and operators can audit the high-risk action. |
| **Gap rating** | **Met** |

### Eligibility requirement 8 — No direct adapter/venue exposure

| | |
|---|---|
| **What the prototype does** | Depositors interact only with the vault. Swap calls to `SWAP_ROUTER` are internal vault operations. |
| **What is missing** | Nothing. |
| **Gap rating** | **Met** |

### ProtocolAssetVault summary

| Requirement | Status |
|---|---|
| Synchronous redemption | **Gap — blocks eligibility** |
| TWAP oracle | **Gap — blocks eligibility** |
| Slippage preview before signing | **Gap — blocks eligibility** (resolved within oracle ADR) |
| Rebalancing model | **Gap — blocks eligibility** |
| ERC-4626 conformance | **Gap — blocks eligibility** (resolved within oracle ADR) |
| Caps | **Dependent gap** (resolved within oracle ADR) |
| Pause / emergency unwind | Met |
| No direct venue exposure | Met |

**Verdict:** ProtocolAssetVault is not Router-eligible. Three independent
ADRs must be approved and implemented before router registration: TWAP
oracle source, rebalancing model, and liquidity proof / synchronous
redemption guarantee.

---

## AgentTokenVault (rmAGENT)

AgentTokenVault inherits all of `BasketVault`. All gaps in ProtocolAssetVault
apply equally. This section documents the additional gap specific to
AgentTokenVault.

### Shared gaps from BasketVault

All five blocking gaps above (synchronous redemption, TWAP oracle, slippage
preview, rebalancing model, ERC-4626 conformance) apply to AgentTokenVault
without change.

The `_DEFAULT_SLIPPAGE_BPS` for AgentTokenVault is 300 bps (3%) versus
100 bps for ProtocolAssetVault, reflecting lower liquidity expectations for
agent-economy tokens. This makes the slippage-preview and liquidity-proof
gaps more acute: the required liquidity proof is harder to satisfy and the
ERC-4626 deviation is larger in the worst case.

### Eligibility requirement 9 — Shortlist governance

| | |
|---|---|
| **What the prototype does** | Token shortlist management is handled entirely by `ADMIN_ROLE` via `addAsset` and `removeAsset` (inherited from `BasketVault`). `AgentTokenVault.shortlist()` exposes the current list as a view for off-chain display. |
| **What is missing** | A production shortlist governance mechanism. `docs/development/open-questions.md` §1.3 and §1.4 note that the three candidate models — (a) protocol-agent curation, (b) RM-token inclusion vote, (c) bribery mechanism — are all unresolved. The PRD explicitly records `Best current answer: TBD` for shortlist ownership and inclusion mechanics. `docs/prd.md` §11.3 states: "This vault is not Router-eligible until shortlist governance, TWAP pricing, and the rebalancing model are specified." Without an on-chain governance mechanism the shortlist is a single-admin write, which violates the transparent-performance requirement (`docs/prd.md` §2) and introduces a trust assumption the product has not accepted. |
| **Gap rating** | **Gap — blocks eligibility** |
| **ADR required** | Yes. See ADR outline: Shortlist Governance Mechanism (Appendix C). |

### AgentTokenVault summary

| Requirement | Status |
|---|---|
| Synchronous redemption | **Gap — blocks eligibility** |
| TWAP oracle | **Gap — blocks eligibility** |
| Slippage preview before signing | **Gap — blocks eligibility** (resolved within oracle ADR) |
| Rebalancing model | **Gap — blocks eligibility** |
| ERC-4626 conformance | **Gap — blocks eligibility** (resolved within oracle ADR) |
| Caps | **Dependent gap** (resolved within oracle ADR) |
| Pause / emergency unwind | Met |
| No direct venue exposure | Met |
| Shortlist governance | **Gap — blocks eligibility** |

**Verdict:** AgentTokenVault is not Router-eligible. Four independent ADRs
must be approved and implemented before router registration: TWAP oracle
source, rebalancing model, liquidity proof / synchronous redemption, and
shortlist governance mechanism.

---

## Gap count by vault

| Gap | ProtocolAssetVault | AgentTokenVault |
|---|---|---|
| TWAP oracle | blocks | blocks |
| Slippage preview | blocks (oracle ADR) | blocks (oracle ADR) |
| Synchronous redemption guarantee | blocks | blocks |
| Rebalancing model | blocks | blocks |
| ERC-4626 conformance | blocks (oracle ADR) | blocks (oracle ADR) |
| Shortlist governance | — | blocks |
| Cap enforcement under TWAP | dependent | dependent |

---

## Optional / non-blocking gaps

These gaps do not block router eligibility but should be resolved before
production launch:

1. **`rescueTokens` basket-asset guard** — `BasketVault.rescueTokens` uses a
   `require` string rather than a custom error, inconsistent with the rest of
   the contract. Low impact.

2. **`removeAsset` leaves index holes** — Deactivated assets remain in the
   `assets` array with `active = false`, causing `_activeAssetCount` to iterate
   over growing dead entries. Under a large basket this is a gas concern. A
   swap-and-pop pattern could be used if ordering is not required.

3. **`totalAssets` loop** — Unbounded `for` loop over `assets.length`. A
   basket approaching `maxAssets` (10 or 15) is unlikely to hit gas limits, but
   the pattern should be documented.

4. **`addAsset` fee-tier validation** — Any `uint24` fee is accepted. Restricting
   to known Uniswap V3 fee tiers (100, 500, 3000, 10000) would prevent
   misconfiguration.

5. **No NAV staleness timestamp** — Once TWAP is implemented, the oracle
   reading should carry a freshness check. The gap report flags this as a
   dependency of the TWAP ADR.

---

## Appendix A — ADR Outline: TWAP Oracle Source Decision

**Decision needed:** Which oracle mechanism replaces slot0 for basket vault NAV
and slippage guard calculations?

**Context:** `BasketVault._quote` currently reads `IUniswapV3Pool.slot0()`. The
prototype comment and `docs/prd.md` §11.2 both require a TWAP replacement before
router eligibility. The ADR must also resolve the slippage-adjusted preview and
ERC-4626 conformance gaps.

**Options to evaluate:**

| Option | Summary | Risk |
|---|---|---|
| A. Uniswap V3 `observe()` TWAP (on-chain) | Call `pool.observe([twapWindow, 0])` and derive price from accumulated tick. No external dependency. | TWAP window is a free parameter; short windows remain manipulable. Must specify window (e.g., 30 min) and minimum cardinality check. |
| B. Chainlink price feed (off-chain aggregate) | Read a Chainlink `AggregatorV3Interface` for each basket token / USD pair. Well-audited; staleness standard. | Requires Chainlink feeds to exist for every basket token on Base. Agent-token basket may include tokens without Chainlink coverage. |
| C. Hybrid (Chainlink primary, Uniswap V3 TWAP fallback) | Use Chainlink if fresh (< heartbeat); fall back to TWAP. | More complex; two audit surfaces; split-brain edge cases. |

**Mandatory ADR outputs:**

- Oracle mechanism and any fallback.
- TWAP window (if option A or C): minimum, default, and governance override path.
- Freshness tolerance: maximum oracle age before deposit/redeem reverts.
- `previewRedeem` update: return spot NAV minus slippage bound, documented as
  the worst-case floor, not an exact quote.
- A conformance note explaining the ERC-4626 deviation and the risk disclosure
  delivered to depositors.
- Per-token oracle availability check: any basket token without a qualifying
  oracle must be blocked from `addAsset` at the registry level.

**Blocks:** router registration of ProtocolAssetVault and AgentTokenVault.

---

## Appendix B — ADR Outline: Rebalancing Model Decision

**Decision needed:** How does a basket vault rebalance existing holdings when
the active asset set changes?

**Context:** The prototype routes only new deposits into equal-weight positions.
Existing holders are not rebalanced when assets are added or removed. This
creates drift that violates the equal-weight mandate over time. `docs/prd.md`
§3.15 documents three open sub-questions: trigger, target, and cost disclosure.

**Sub-questions for the ADR:**

1. **Trigger mechanism**

   | Option | Summary |
   |---|---|
   | Admin-initiated | Admin calls `rebalance()`; no on-chain automation. Simple, cheap to implement. Requires off-chain keeper discipline. |
   | Keeper-automated | A keeper contract or off-chain bot watches asset-set changes and calls `rebalance()` within a configurable delay. Adds keeper trust assumption. |
   | Deposit-piggybacked | Every deposit corrects drift for the depositing account only (self-service). No global rebalance needed. Simpler but drift persists for non-depositing accounts. |

2. **Target weights**

   | Option | Summary |
   |---|---|
   | Equal weight (current prototype behavior at deposit) | Simple; no governance required. |
   | Governed weight vector | Requires the basket to adopt a weight-governance mechanism analogous to Portfolio Router weights. Adds significant complexity. |

3. **Cost and slippage disclosure**

   - Any rebalance function must emit a pre-execution preview of estimated
     slippage cost before execution or require explicit admin acknowledgment.
   - Cost must be disclosed in the vault's event stream so the explorer can
     surface it.
   - The ADR must state whether rebalancing cost is borne by all shareholders
     (socialized) or only by the triggering depositor (self-service).

**Mandatory ADR outputs:**

- Chosen trigger mechanism.
- Chosen target weights.
- `rebalance()` function signature (if any).
- Pre-execution cost-preview mechanism.
- Shareholder impact disclosure text for the dapp and `rmpc` output.

**Blocks:** router registration of ProtocolAssetVault and AgentTokenVault.

---

## Appendix C — ADR Outline: Shortlist Governance Mechanism (AgentTokenVault only)

**Decision needed:** Who may add or remove tokens from the AgentTokenVault
shortlist, and through what on-chain process?

**Context:** The prototype gives full shortlist authority to `ADMIN_ROLE`
(a single multisig or EOA). `docs/development/open-questions.md` §1.3 and §1.4 document three
competing models and record the product answer as TBD. The bribery-based flow
described by the product owner ("AIs try to bribe in their own assets to
vaults") has no specified on-chain mechanic.

**Options to evaluate:**

| Option | Summary | Risk |
|---|---|---|
| A. Admin multisig (prototype, current) | N-of-M multisig controls `addAsset`/`removeAsset`. No further governance. | Trust-centralized; violates transparent-performance requirement for router-eligible vault. Acceptable for prototype; not for production. |
| B. RM-token inclusion vote | `$RM` holders propose and vote on shortlist changes via an on-chain governance module. Quorum, delay, and execution path required. | Requires a voting contract and token-vote mechanics not yet specified (see `docs/development/open-questions.md` §3.9). Adds significant implementation scope. |
| C. Bribery/incentive mechanism | Agent-economy token projects pay a fee in `$RM` or USDC to nominate tokens; RM holders vote on ranked inclusion. | Most complex; requires fee-collection, bribery-escrow, and ranked-vote logic. Explicitly flagged as future spec work. |
| D. Protocol-agent curation with timelock | Protocol agent (off-chain agent) proposes shortlist changes; changes are queued behind an on-chain timelock allowing RM holders to veto before execution. | Balances automation with community oversight; timelock duration is a free parameter. Adds agent-failure risk. |

**Mandatory ADR outputs:**

- Chosen governance model.
- Timelocks and delay parameters (for all options with a queuing step).
- Veto / challenge mechanism (if any).
- Maximum shortlist size per model.
- Attack economics analysis: cost to bribe in a low-value or malicious token.
- `addAsset` gate additions required (e.g., minimum RM vote threshold, minimum
  liquidity proof, oracle availability check from Appendix A ADR).

**Blocks:** router registration of AgentTokenVault only.

---

## Resolution order

Before any basket vault implementation issue begins:

1. **TWAP Oracle ADR** (Appendix A) — prerequisite for both vaults. Also
   resolves slippage-preview and ERC-4626 conformance gaps.
2. **Rebalancing Model ADR** (Appendix B) — prerequisite for both vaults.
3. **Shortlist Governance ADR** (Appendix C) — prerequisite for AgentTokenVault
   only; may be parallelized with items 1 and 2.
4. **Liquidity proof process** — per-token liquidity review for each basket
   token candidate; must satisfy the synchronous-redemption guarantee.

No basket vault implementation issue should be opened until the relevant ADR
is approved and linked from the implementation issue.
