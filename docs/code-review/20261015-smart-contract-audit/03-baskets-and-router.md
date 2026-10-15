# Baskets and router

## 3. Basket assets, swaps, oracles, and economic safety

- Validate asset/pool registration, token ordering, decimals, pool identity, observation history, oracle bounds, freshness/staleness, zero or degenerate prices, and reconfiguration.
- Trace every swap and unwind path, including normal, emergency, override, and partial-failure paths. Check minimum output, maximum loss, deadlines, checked casts, return-array lengths, reentrancy, token callbacks, and atomicity across multiple legs.
- Verify deposit and redemption NAV marks against executable prices and realistic slippage. Test TWAP/spot disagreement, stale or manipulated observations, sampling cadence, ring size, missing honest updates, repeated samples, thin liquidity, fees, and arbitrage/keeper competition.
- Check per-caller and per-leg floors, router previews, unavailable legs, zero-weight and skipped legs, and whether a failure in one leg should revert or safely skip the whole operation.
- Model transaction ordering and economic feasibility: flash liquidity, transaction bundles, sandwich and back-run timing, keeper/oracle competition, fees, pool depth, protocol caps, and attacker profit versus user loss under the actual deployment settings.
- Review removal/reappearance of basket assets, rescue/sweep protections, and whether a returned token or residual position can become stranded or misattributed.
## 4. Router and multi-vault composition

- Validate registry membership, vault status and eligibility, default and user weight vectors, uniqueness, sum, ordering, stale lengths, caps, and updates during an operation.
- Trace deposits, `depositFor`, `depositTo`, withdrawals, redemptions, previews, per-leg minimums, skipped legs, unavailable legs, and partial success. Check receiver and asset attribution and prevent duplicate counting or loss of caller protections.
- Verify receipt/digest binding, nonce and replay protection, expiry/deadline behavior, weight-vector provenance, and the relation between a previewed vector and the vector used at execution.
- Check governance/application paths and all legacy routes: no bypass through an alternate setter, default vector, migration, or retired governance contract.
- Verify invariant behavior when router weights, registry status, vault implementations, or leg availability change between preview, signature, and execution; confirm previously held positions remain redeemable after a leg is retired or reweighted.
