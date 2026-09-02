# Hybrid NAV Design — System Guards + User Asset Clarity

## Design Rationale

This document specifies the **hybrid approach** that resolves the unspecified gap between "NAV-mediated position" (implicit) and "user-specific assets" (explicit) without fully transitioning to the latter's on-chain complexity.

The hybrid approach has two layers:

| Layer | Purpose | What It Governs | User Visible Effect |
|---|---|---|---|
| **System NAV Layer** | Protocol-level guards and accounting | NAV growth limit, ORA-4 deviation guard, vault withdraw liveness, TVL caps, adapter eligibility | NAV shown in UI; determines system solvency; NOT user outcome determinator |
| **User Position Layer** | User economic outcome clarity | What user deposited, what they own, what they'll receive on exit | UI explicitly shows: "You own X USDC + Y Token (market price). NAV is system accounting only." |

## Core Principle

> **NAV = system guards only. User position = market-purchased assets.**

The protocol maintains NAV for:
- NAV growth rate limiter (prevents admin inflation)
- ORA-4 NAV-deviation guard (reverts entry-side deploy if spot > TWAP + 2000 bps)
- TVL cap enforcement
- Adapter eligibility and capBps checks
- Withdrawal liveness (exempt from NAV growth gate, per design rationale #1211)

But NAV does NOT determine:
- Share mint/burn count for the user
- User's exit amount
- Fee bears responsibility
- Slippage experienced

Instead, the user position layer provides explicit clarity.

## User Position Semantics (Hybrid)

### Deposit

```
User calls deposit(assets, receiver)
  │
  ├─ User's USDC is used to purchase underlying assets via adapter(s)
  │   └─ Adapter routes USDC→token through venue (Uniswap V4 Router, Aerodrome, etc.)
  │   └─ User receives minted token shares from the pool
  │
  ├─ NAV is updated: totalAssets() increments by assets' contribution
  │   └─ System guards run (growth limit, ORA-4) but do NOT affect user outcome
  │
  └─ User receives:
      • Vault shares (ERC-4626 conformance) representing proportional claim
      • BUT: UI explicitly documents: "Shares value = market price of underlying assets, NOT NAV"
      • Purchase price and assets recorded per-deposit (off-chain indexing; not on-chain per-user)
```

**What user sees in UI**:
```
Deposited: 1000 USDC
Received: 950 shares (95% of 1000 after 5% slippage floor)
Underlying assets: 950 USDC worth of basket tokens at market price
NAV (system): 1010 USDC (slightly higher due to fees captured by other depositors)
Note: NAV is system accounting; your share value = market price of your underlying assets
```

### Redeem/Withdraw

```
User calls redeem(shares) or withdraw(assets)
  │
  ├─ User's shares are burned: _burn(owner, shares)
  │
  ├─ Assets pulled proportionally from adapters' totalAssets() (existing behavior)
  │   └─ _pullProportional: idleBalance first, then proportional pull from each counted adapter
  │
  ├─ NAV is decremented: totalAssets() decrements by assets' withdrawal contribution
  │   └─ System guards do NOT run on withdraw path (preserves liveness, per #1211)
  │
  └─ User receives:
      • USDC = f(shares, adapter liquidity at exit) — existing behavior
      • BUT: UI explicitly documents: "You receive market-clearing value of your underlying assets, minus exit fees"
      • "NAV at withdrawal = X; your exit value = Y; difference due to market movement and pro-rata liquidity"
```

**What user sees in UI**:
```
Redeeming: 950 shares
Received: 970 USDC (after exit fee of 20 USDC)
Underlying assets redeemed: 950 shares × (market price at exit / market price at deposit)
NAV at withdrawal: 990 USDC (system); your exit = 970 USDC (market-adjusted)
Note: NAV changed from deposit to withdrawal due to market movement; your exit reflects your share of adapter liquidity
```

## How This Differs from Pure Designs

| Design | NAV Determines User Outcome? | User Knows What They Own? | Fees/Slippage Transparent? |
|---|---|---|---|
| **Implicit (current)** | Yes — share mint/burn, exit amount all via NAV | No — vague proportional claim on vault | Hidden in realizedDelta; not itemized |
| **Explicit (full asset tracking)** | No — user owns specific assets; NAV secondary | Yes — receipt tokens show exact assets | Fully itemized at user level |
| **Hybrid (this doc)** | **No for user outcome, Yes for system guards** | **Partially — UI explicitly documents NAV vs. market gap** | **Semi-transparent: fees/slippage itemized in UI, not on-chain** |

## What Changes in Code (Minimal)

The following Vault.sol functions need **semantic updates** (not mechanical rewrites) to reflect the hybrid approach:

1. **`previewDeposit()`** — Add explicit note: "Returns NAV-proportional shares, NOT market price. See UI for market-adjusted estimate."

2. **`previewRedeem()`** — Add explicit note: "Returns NAV-proportional USDC, NOT market sale proceeds. See UI for market-adjusted estimate."

3. **`_deposit()`** — Add comment block after `mintShares` calculation:
   ```
   /// NAV delta determines share count per ERC-4626 convention.
   /// User's share VALUE = market price of underlying assets, NOT this NAV.
   /// UI must disclose: "NAV is system accounting; your price = market."
   ```

4. **`_withdrawExact()` / `_withdrawInexact()`** — Add comment block after user USDC out:
   ```
   /// User receives proportional pull from adapter liquidity.
   /// NAV at withdrawal differs from deposit NAV due to market movement.
   /// User's exit value = their pro-rata of underlying assets, not NAV-based calculation.
   ```

5. **`totalAssets()`** — Document dual role:
   ```
   /// @notice System NAV: used for growth limit (ORA-7), ORA-4 deviation guard,
   ///         TVL cap, and vault solvency assessment.
   /// @notice NOT user position value: user's share value = market price of
   ///         underlying assets held, not this totalAssets() value.
   ```

6. **Events** — Add optional parameters or topics for NAV-awareness:
   ```
   event Deposit(..., uint256 navBefore, uint256 navAfter, bool navAffectsUserOutcome);
   event Withdrawal(..., uint256 navBefore, uint256 navAfter, bool navAffectsUserOutcome);
   ```

## What Changes in UI/Dapp

The dapp needs to surface the NAV-versus-market gap explicitly:

1. **Deposit screen**: Shows "You will receive ~X shares" + footnote "NAV-based; market price may differ. See ?"

2. **Withdraw screen**: Shows "You will receive ~Y USDC" + footnote "Pro-rata adapter liquidity; NAV changed from deposit to withdrawal. See ?"

3. **Position view**: Shows "Your 100 shares represent ~Z basket tokens at current market. NAV (system) = W. Note: NAV is system accounting."

4. **Preview before approval**: Modal with two values:
   - "NAV-proportional: X shares / Y USDC (protocol calculation)"
   - "Market-adjusted: A shares / B USDC (estimated market value, with slippage disclaimer)"

5. **Help/tooltips**: everywhere NAV appears, add: "NAV is the protocol's system-level valuation, used for growth limits and guards. Your actual deposit/withdraw value depends on market prices and adapter routing."

## What Changes in Specs (Existing Documents)

### `docs/technical/asset-valuation.md` (already written)
- Keep as-is: critiques NAV as informational, not market price — aligns with hybrid approach

### `docs/technical/asset-flow-semantics.md` (already written)
- Keep as-is: documents implicit vs. explicit design gap — aligns with hybrid approach identifying the gap

### `docs/prd.md` — Update § "Deposit" and § "Withdrawal" sections
- Add clause: "Deposits mint shares proportional to realized NAV delta (per ERC-4626). User's share VALUE = market price of underlying assets. NAV is system accounting; see help tooltip for market-adjusted estimate."
- Add clause: "Withdrawals burn shares and pull proportionally from adapter liquidity. User's exit USDC = pro-rata of underlying assets at exit NAV. NAV may have changed from deposit; difference due to market movement. See help tooltip."

### `docs/architecture.md` — Update vault section
- Update vault standard description to mention hybrid NAV model:
  ```
  ERC-4626 for individual vaults | Standard deposit, withdraw, redeem, preview, conversion, and `totalAssets()` surface.
  NAV dual role: system guards (growth limit, ORA-4 deviation, TVL cap) AND informational only for user outcomes.
  UI must explicitly disclose: "NAV is system accounting; your share value = market price of underlying assets."
  ```
- Update BasketVault entry/exit description:
  - Keep Chronicle oracle for RWA, TWAP for Base V3/V4
  - Add: "NAV priced via TWAP; user position value via market price of held assets. Hybrid model: NAV for protocol guards, market price for user outcomes."

### `docs/technical/definitions.md` — Update NAV definition
- Add to NAV definition: "Dual role: (1) system-level valuation for protocol guards (growth limit, ORA-4 deviation, TVL cap), (2) informational reference for user position; user share value = market price of underlying assets, not NAV."

### New/Updated ADRs
- Consider ADR for "NAV dual role" — documenting the intentional separation of system NAV vs. user position value
- Or update existing ADR-0010 (unified vault architecture) to footnote the hybrid model

## Diagram: Hybrid NAV Flow

```
                          +----------------------+
                          |   User Interface     |
                          |  (deposit/withdraw)  |
                          +----------+-----------+
                                     |
                                     v  (with explicit NAV vs. market disclaimer)
                          +----------------------+
                          |   User Position      |
                          |   (on-chain shares)  |
                          +----------+-----------+
                                     |
               mint/burn via realizedDelta  (ERC-4626 convention)
                                     v
                          +----------------------+
                          |   Vault Contract     |
                          |   (Vault.sol)        |
                          |  • totalAssets()     |
                          |  • NAV growth limit  |
                          |  • ORA-4 deviation   |
                          |  • TVL cap enforcement|
                          +----------+-----------+
                                     |
                                     v (system guards only; NOT user outcome determinator)
                          +----------------------+
                          |   System Accounting  |
                          |   (NAV for guards only)|
                          +----------------------+
```

## Mitigations Still Required

Even with the hybrid approach, these mitigations from `asset-valuation.md` and `asset-flow-semantics.md` still apply:

1. **Extend `preview*` functions** to simulate slippage (optional market-adjusted estimates)
2. **Reduce TWAP window configurability** (shorter TWAP = NAV closer to market = smaller gap)
3. **Add explicit NAV staleness warnings** (when block.timestamp - lastNavCheckpointTime > threshold, UI flags)
4. **Document the NAV-versus-market expectation** (onboarding, help center, API docs)
5. **Add `slippage` parameter to `previewDeposit`** (user specifies acceptable slippage; preview reverts if exceeded)

## Conclusion

The **hybrid approach** resolves the unspecified gap without the full on-chain complexity of user-specific asset tracking. It:

- ✅ Preserves all system-level NAV guards (growth limits, ORA-4, TVL caps, liveness)
- ✅ Provides explicit UI documentation of the NAV-versus-market gap
- ✅ Requires minimal code changes (semantic comments + UI updates, not mechanic rewrites)
- ✅ Aligns with the protocol's gas efficiency and adapter abstraction goals
- ✅ Gives users transparent understanding of what NAV does and doesn't mean for them

The key insight: **NAV remains the protocol's accounting backbone, but the user interface becomes the bridge that translates NAV into user-understandable market value — with explicit disclaimers where they diverge.**

---
**Cross-referenced documents**: `asset-valuation.md` (critique), `asset-flow-semantics.md` (gap analysis), `prd.md` (product requirements), `architecture.md` (system design), `definitions.md` (term definitions)