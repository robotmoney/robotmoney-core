# Asset Valuation Critique

## User's Position

> "A new deposit should buy the assets in the market, at the market price. When a share is redeemed, it is sold in the market. The NAV is not relevant for this, NAV is informational and can be VERY incorrect, since it doesn't account for trading feeds/slippage the user may encounter."

## Design Analysis

### Current NAV-Based Mechanism (Vault.sol)

| Operation | NAV Mechanism | User Outcome |
|-----------|-------------|-------------|
| **Deposit** | `shares = realizedDelta × (supply+1) / (taBefore+1)` where `realizedDelta = taAfter - taBefore` | User gets shares proportional to the NAV increase *captured by adapters*. If adapters route poorly (high slippage, low liquidity), `realizedDelta` is small → fewer shares minted. |
| **Redeem/Withdraw** | `assets = f(shares, totalAssets())` — proportional pull from adapter `totalAssets()` | User gets USDC proportional to their share of adapter liquidity. If adapters have low net asset value, user receives less. |
| **Preview** | `previewDeposit()` / `previewRedeem()` return NAV-based estimates | UI estimates based on TWAP, not executable market prices. |

### The Critique's Core Argument

The user argues that NAV-based valuation creates a fundamental mismatch:

1. **NAV is a backward-looking average** (TWAP over configurable window), not a forward-looking market price
2. **Users trade at market prices with slippage**, but NAV doesn't capture:
   - Trade execution slippage
   - Fee tiers taken by adapters
   - Real-time order book conditions
   - Path-dependent routing effects

3. **Result**: Users may deposit/redeem at "wrong" NAV prices, receiving disproportionate value:
   - Deposit when markets are thin → get fewer shares than NAV suggests
   - Redeem when markets are thick → receive more/less than NAV suggests

### Design Rationale (Why NAV Was Chosen)

The NAV mechanism was chosen over direct market pricing for several reasons:

1. **Gas efficiency** — Real on-chain market pricing for every deposit/withdraw would require expensive oracle queries or router calls in every transaction

2. **Sybil resistance** — A TWAP-based NAV is harder to manipulate in a single transaction than a spot price, providing more stable share valuation

3. **Consistency** — All users depositing/withdrawing in the same period get proportionally the same treatment, regardless of exact timing

4. **Adapter abstraction** — The vault doesn't know the "market price" — it only knows what adapters report via `totalAssets()`. The adapters abstract away the actual DEX mechanics.

5. **Liveness preservation** — The NAV growth limit deliberately does NOT gate withdrawals (per design rationale #1211), ensuring users can always exit even if NAV is "wrong"

### Where the Critique is Valid

The user's concern highlights real operational issues:

1. **User experience mismatch** — Users expect "deposit at market price, redeem at market price," but receive NAV-proportional amounts. The dapp UI's `preview*` functions should bridge this, but often don't clearly communicate the NAV basis.

2. **NAV staleness risk** — If TWAP windows are long and markets move fast, NAV can diverge significantly from executable prices. The basket-vault-gap-report.md already flags this.

3. **Adapter liquidity vs. NAV disparity** — Adapters may report healthy NAV but have insufficient actual liquidity for withdrawals (the `InsufficientAdapterLiquidity` revert is the protocol's acknowledgment of this exact gap).

4. **Slippage not modeled in previews** — `previewDeposit()` and `previewRedeem()` compute NAV deltas without simulating actual trade slippage, so users may be surprised by execution prices.

### Where the Design Holds

Despite the critique, the NAV mechanism serves important purposes:

1. **Protocol-level NAV growth guard** — Preventsadmin/timelock from allowing NAV to inflate faster than genuine asset growth (section 4.3a). This protects the system from monetary manipulation.

2. **Cross-adapter consistency** — Without NAV, each adapter would need its own pricing mechanism, fragmenting the vault's accounting. NAV provides a unified denominator.

3. **The "non-decreasing" invariant** — NAV can only grow at a capped rate, preventing the vault from issuing shares against inflated value. This is a system-level safeguard, not a user-level price guarantee.

4. **Withdrawal liveness** — The explicit design choice to exempt withdrawals from the NAV growth gate ensures the protocol doesn't brick user exits during market stress.

### Synthesis: Where NAV Fits in the Value Chain

```
User → Deposit USDC → Adapter Routes → totalAssets() Increments → Shares Minted
     ↑                                                           ↑
   Market Prices                                           NAV (TWAP-based)

User → Redeem Shares → Adapters Liquidated → totalAssets() Decrements → USDC Out
     ↑                                                           ↑
   Market Prices                                           NAV (TWAP-based)
```

The gap between **Market Prices** (what users actually get) and **NAV** (the protocol's valuation) is the source of the critique. The protocol accepts this gap because:

- Fixing it fully would require on-chain price discovery for every operation (prohibitively expensive)
- The gap is partially bridged by UI `preview*` functions (if well-communicated)
- The system-level guards (NAV growth limit, ORA-4 deviation) protect against manipulation more effectively than user-level price accuracy
- Withdrawal liveness is preserved by exempting exits from NAV gates

### Recommended Mitigations

If the protocol wants to address the user's concern without full market-pricing overhead:

1. **Extend `preview*` functions to simulate slippage** — Run router `exactInputSingle` calls in preview to estimate real trade outcomes, not just NAV deltas.

2. **Reduce TWAP window configurability** — Shorter TWAP windows make NAV more responsive to market moves, narrowing the NAV-versus-market gap.

3. **Add explicit NAV staleness warnings** — When `block.timestamp - lastNavCheckpointTime > some threshold`, dapp UI should flag that NAV may not reflect current market conditions.

4. **Document the NAV-versus-market expectation** — Clear onboarding docs explaining that shares are minted/redeemed against TWAP-derived NAV, not real-time market prices, and that slippage/fees affect actual outcomes.

5. **Add `slippage` parameter to `previewDeposit`** — Allow users to specify acceptable slippage, and have the preview compute whether the trade would fall within that bound (reverting if not, so users know upfront).

### Conclusion

The user's critique is **largely valid from a user-experience perspective** — NAV is informational system accounting, not a market-price guarantee. Users *do* encounter slippage and fees that NAV doesn't capture, and the mismatch can cause surprising outcomes.

However, the design choice to use NAV over market pricing is **intentionally pragmatic** — full on-chain market pricing per operation is infeasible, and the NAV mechanism provides system-level safeguards (growth limits, manipulation resistance) that would be harder to maintain with per-transaction pricing.

The right resolution isn't to abandon NAV, but to **bridge the gap** through better UI communication, slippage-aware previews, and explicit documentation of the NAV-versus-market distinction. The protocol already acknowledges some of this via the gap report and ORA-4 guards; the missing piece is user-facing transparency about what NAV does and doesn't guarantee.