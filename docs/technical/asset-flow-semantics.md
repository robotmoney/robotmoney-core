# Asset Flow Semantics — Implicit vs. Explicit Design

## The Unspecified Gap

> **"We previously hadn't fully specified how the assets enter or exit the vault, related to the user's actions."**

This gap refers to the **semantic contract** between user transactions and asset ownership. The Vault.sol code has the mechanical flow (transfer → route → compute → mint/burn), but the *meaning* of user position was never formally specified.

## Current (Implicit) Design: NAV-Mediated Position

### Deposit Flow (lines 536-650, Vault.sol)

```
User calls deposit(assets, receiver)
  │
  ├─ Pull caller's USDC: safeTransferFrom(caller, vault, assets)
  │
  ├─ Route into adapters: _routeDeposit(assets) — flat equal-split across all adapters
  │   ├─ Each adapter receives equalShare = assets / n_adapters
  │   ├─ _allocateTo(i, allocation): safeTransfer(adptAddr, amount); adpt.deploy(amount, minValueOut)
  │   │   └─ Inside adapter: USDC→token swap via Uniswap V4 Router
  │   │   └─ User receives token shares from the pool
  │   └─ Adapter's totalAssets() increments
  │
  ├─ Compute NAV delta: taAfter - taBefore (post-route vs. pre-route totalAssets)
  │   └─ realizedDelta = actual value captured by adapters' routing
  │
  ├─ Mint shares: realizedDelta × (supply+1) / (taBefore+1)
  │   └─ Share count depends on routing quality, not user's intent
  │
  └─ emit Deposit(caller, receiver, assets, mintShares)
```

**Implicit semantic assumption**: User's `mintShares` represents a **proportional claim on the vault's aggregate NAV**. The user does NOT own specific underlying assets — they own "shares of the vault," whose value fluctuates with the TWAP-derived NAV.

**What users DON'T see**:
- What specific assets their shares represent
- What fees were taken from their deposit
- What slippage affected their execution
- Whether their deposit increased or decreased the value of other users' positions

### Withdraw/Redeem Flow (lines 866-957, Vault.sol)

```
User calls redeem(shares) or withdraw(assets)
  │
  ├─ If INEXACT mode: _withdrawInexact — proportional pull from adapter liquidity
  │   ├─ idleBalance first, then _pullProportional from each counted adapter
  │   └─ _pullProportional: idleBalance + proportional pull from adapter totalAssets()
  │   └─ User gets USDC = f(shares, adapter liquidity at time of exit)
  │
  ├─ If EXACT mode: _withdrawExact
  │   ├─ Convert shares → assets via _convertToAssets(totalAssets())
  │   ├─ _pullProportional(grossAssets) — proportional pull from adapters
  │   ├─ Fee on gross: fee = gross - assets_out
  │   └─ User gets assets_out USDC (net of fee)
  │
  └─ Shares burned: _burn(owner, shares)
```

**Implicit semantic assumption**: User's `redeem(shares)` or `withdraw(assets)` gives back **proportional value from the current vault basket**. The user receives whatever assets the vault has at exit time, not necessarily what they deposited.

**What users DON'T see**:
- Whether they're getting back the same assets they deposited
- Whether their position gained or lost value relative to their deposit
- How much of the exit fee came from their specific position vs. the vault's aggregate

## Corrected (Explicit) Design: User-Specific Asset Position

### Deposit Flow (redesigned)

```
User calls deposit(assets, receiver)
  │
  ├─ User's USDC is used to purchase SPECIFIC underlying assets at market price
  │   ├─ Price obtained via oracle or router call (exactInputSingle etc.)
  │   └─ Quantity purchased = assets / price_per_share_unit
  │
  ├─ User receives ASSET RECEIPT TOKENS representing the specific assets purchased
  │   ├─ ERC-721 or ERC-1155 token per user, or
  │   └─ Vault shares with metadata: {deposit_block, assets_deposited, price_at_deposit}
  │
  ├─ NAV is updated (totalAssets++) but does NOT determine share count
  │   └─ NAV growth limit still runs (system guard, not user outcome)
  │
  └─ emit Deposit(caller, receiver, assets, receipt_token_id)
```

**Explicit semantic assumption**: User's position represents **direct ownership of specific underlying assets**. The user knows exactly what they own, and NAV is secondary information.

### Redeem Flow (redesigned)

```
User calls redeem(shares) or withdraw()
  │
  ├─ User redeems their SPECIFIC underlying assets
  │   ├─ Identify user's receipt tokens / underlying asset records
  │   ├─ Sell those specific assets at market price
  │   └─ User receives: market_price × quantity - fees
  │
  ├─ NAV is decremented (totalAssets--) for system accounting only
  │   └─ Does NOT affect user's exit amount
  │
  └─ User receives USDC from sale of their specific assets
```

**Explicit semantic assumption**: User gets back the economic equivalent of what they deposited, adjusted for market movements and fees they bear.

## What Changed: The Specification Gap

| Aspect | Implicit Design (Current) | Explicit Design (Corrected) |
|---|---|---|
| **User position** | "Shares of vault, value = NAV" | "Own specific assets, value = market price" |
| **Deposit mediates** | USDC → vault NAV → shares | USDC → specific assets → user receipt |
| **Redeem mediates** | Shares → vault NAV → USDC | User assets → market → USDC |
| **Fees who bears** | Protocol (hidden in realizedDelta) | User (explicitly itemized) |
| **Slippage who bears** | Protocol (reverts if below floor) | User (execution risk) |
| **NAV role** | Determines share mint/burn | Informational only; system guards only |
| **Position tracking** | Vault-level aggregate | User-level specific assets |
| **Rebalancing impact** | Affects all users proportionally | Affects specific user positions |
| **Tax implications** | Cost basis = share purchase price | Cost basis = specific asset purchase price |

## Code Areas Requiring Specification

If adopting the corrected design, these Vault.sol functions need semantic clarity:

1. **`_deposit()`** — Currently mints shares based on `realizedDelta`. Would need to:
   - Track per-user underlying assets purchased
   - Issue receipt tokens (not just share count)
   - Store purchase price per user

2. **`_withdrawExact()` / `_withdrawInexact()`** — Currently pulls proportional from aggregate adapters. Would need to:
   - Identify user's specific underlying assets
   - Sell those assets, not proportional pool pull
   - Return proceeds to user, not proportional aggregate

3. **`totalAssets()`** — Currently the load-bearing NAV. Would need to:
   - Distinguish "system NAV (for guards)" vs. "user position value"
   - Or remove as user-outcome determinator

4. **`_routeDeposit()`** — Currently flat equal-split across adapters. Would need to:
   - Either keep (if adapters are just routing mechanisms)
   - Or replace with user-specific asset purchase routing

5. **Preview functions** (`previewDeposit`, `previewRedeem`) — Currently return NAV-based estimates. Would need to:
   - Return market-price-based estimates
   - Or explicitly flag "NAV-based, not market-price"

## Why This Gap Existed

The implicit design was a **pragmatic choice** for MVP:

1. **Gas efficiency** — Per-user asset tracking on-chain is expensive; NAV aggregation is cheap
2. **Smart contract simplicity** — No user-specific state required; one vault state serves all
3. **Dapp abstraction** — UI can present NAV without knowing per-user underlying assets
4. **Interoperability** — ERC-4626 conformance expects share-based, not asset-based, semantics

The trade-off: **User experience ambiguity** — users don't clearly understand what they own, what fees they paid, or what they'll get on exit.

## Recommended Specification

If the protocol adopts the corrected design, the following should be formally specified:

1. **User position model** — Shares receipt tokens vs. direct asset ownership vs. hybrid
2. **Deposit semantic** — What the user receives, what they own, how price is determined
3. **Redeem semantic** — What the user gets back, how market price vs. NAV affects outcome
4. **Fee model** — Who bears fees, how they're calculated, how they're itemized for user
5. **Slippage model** — How slippage is handled, who bears the risk, preview transparency
6. **NAV role** — Explicitly: system guards only, NOT user outcome determinator
7. **Position tracking** — On-chain state required, off-chain indexing, UI representation

## Cross-Reference with Other Documents

This gap connects to several existing documents:

- **basket-vault-gap-report.md** — Flags "No NAV staleness timestamp" and the NAV-versus-market divergence
- **asset-valuation.md** — New file critiquing NAV as informational vs. market price
- **definitions.md** — Defines NAV as "deposit, withdraw, receipt, NAV, risk state, and performance"
- **unified-vault-spec.md** — Specifies NAV-haircut redemption and ORA-4 guard behavior
- **real-four-vault-demo-seams.md** — Chronicles NAV oracle (Chronicle) vs. TWAP design decisions

The user's point clarifies that the protocol chose an implicit design without formally documenting the trade-offs. The corrected design makes those trade-offs explicit but requires significant on-chain and off-chain changes.

---

**Next steps if pursuing corrected design**:

1. Formalize the user position model (shares, receipt tokens, or hybrid)
2. Decide per-user vs. aggregate tracking approach
3. Specify deposit/redeem semantic contracts
4. Update Vault.sol functions accordingly
5. Update dapp UI to communicate the new semantics
6. Update all dependent specs (gap report, ORA-4, etc.) to reflect new model

**Or, hybrid approach** (recommended): Keep NAV for system guards (growth limits, ORA-4 deviation) but add optional user-level asset tracking for users who want it, with clear documentation that "NAV is system accounting, not your personal price."