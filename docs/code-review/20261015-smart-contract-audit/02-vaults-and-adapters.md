# Vaults and adapters

## 1. Asset accounting and ERC-4626 behavior

- Reconcile `totalAssets`, idle balances, adapter balances, fees, pending recoveries, and excluded/quarantined positions. Verify deposits, mints, withdrawals, redeems, previews, and max functions against the same accounting model.
- Check first-depositor and donation/inflation behavior, virtual shares, rounding direction, decimal scaling, zero supply, zero NAV, partial exits, full exits, and repeated small operations.
- Check exactness and consistency of `deposit`/`mint`/`withdraw`/`redeem`, including exit fees, slippage haircuts, shutdown and pause states, and user-specified minimum proceeds.
- Verify `maxDeposit`, `maxMint`, `maxWithdraw`, and `maxRedeem` reflect caps, pauses, shutdown, available liquidity, and the actual operation's ability to succeed.
- Trace every path that changes NAV or share supply: deposits, withdrawals, donations, rebalance, emergency withdrawal, adapter removal/re-addition, exclusions, recovery, fees, and migration.
## 2. Adapters, vaults, and recovery accounting

- Verify adapter eligibility, address/code-hash pins, token and vault compatibility, caps, uniqueness, activation/deactivation, revocation, and reactivation. Ensure duplicate or stale entries cannot double-count assets or block recovery.
- Trace withdrawal failure, partial withdrawal, illiquidity, false or reverting `totalAssets`, over-delivery, under-delivery, residual idle funds, and token approval behavior. Check that accounting records actual received amounts.
- Examine `removeAdapter`, force removal, emergency exclusion, emergency withdrawal, drain-all, rebalance, and re-add sequences. Establish whether recoverable value remains attributable to the holders who owned it when excluded, including holders who exit and the zero-supply case.
- Check that pause/shutdown and quarantine gates compose correctly with deposits, keeper actions, rebalances, emergency recovery, and restoration. Confirm keepers cannot undo an emergency action or redeploy into an ineligible venue.
- Review lending integrations (Aave, Compound, Morpho, or current equivalents): NAV versus immediately withdrawable value, market stress, supply refusal, exposure caps, rounding, approvals, and venue pause behavior.
