# ADR-0003: Slippage-adjusted basket-vault previewRedeem/previewDeposit (worst-case floor)

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** Engineering lead
- **Related:** `docs/technical/basket-vault-gap-report.md` §3, §5; `contracts/vaults/BasketVault.sol`; `docs/architecture.md` §4.4, §8; `docs/prd.md` §11.2, §11.3

## Context

`BasketVault.previewRedeem` currently applies only the exit fee and ignores
swap slippage (see `basket-vault-gap-report.md` §3). The previewed amount is
therefore systematically optimistic: a caller receives at most
`previewRedeem(shares)` USDC on a deposit, but the actual `_withdraw` path
calls `_sellProportional` which applies `amountOutMinimum = spotAmount *
(1 - maxSlippageBps / 10_000)` for each basket token swap. Under worst-case
slippage the caller receives `previewRedeem(shares) * (1 - maxSlippageBps /
10_000)` USDC — a deviation of up to `maxSlippageBps` (300 bps for
AgentTokenVault, 100 bps for ProtocolAssetVault).

The ERC-4626 standard requires `redeem(shares, receiver, owner)` to return at
least `previewRedeem(shares)` assets (section 4 of EIP-4626). With swap
slippage the guarantee is violated in the worst case, which:

1. blocks router eligibility (`docs/architecture.md` §4.4, §8 — "slippage,
   oracle, liquidity, or quote-freshness risk must surface bounds before
   signing");
2. prevents the Portfolio Router from using the preview return value as a
   safe lower bound when computing allocation legs.

`basket-vault-gap-report.md` §3 rates this gap as **blocks eligibility** and
§5 notes it is resolved jointly with the TWAP oracle ADR. This ADR resolves
the preview and ERC-4626 conformance sub-problem independently of the oracle
source decision, so that the implementation issue can proceed as soon as the
oracle ADR is also accepted.

## Decision

### 1. `previewRedeem` — worst-case floor formula

`previewRedeem(shares)` **must** return the worst-case floor:

```
grossAssets = convertToAssets(shares)           // TWAP-based NAV once oracle ADR is implemented
afterSlippage = grossAssets × (MAX_BPS − maxSlippageBps) / MAX_BPS  (floor division)
floor = afterSlippage − afterSlippage × exitFeeBps / MAX_BPS        (floor division)
```

Rounding direction: both multiplications use **floor** (`Math.Rounding.Floor`)
so that the returned value is always ≤ what the caller actually receives.
This maintains the ERC-4626 invariant: `redeem` proceeds only if actual swap
output ≥ `amountOutMinimum`; `amountOutMinimum` is computed by `_withdraw`
using the same `(1 − maxSlippageBps)` factor, so actual output ≥ floor
by construction.

Until the TWAP oracle ADR is implemented, `grossAssets` continues to use the
current slot0-based `_convertToAssets`. The slippage correction is applied on
top of whatever oracle is in use; the implementation issue must apply both
changes together.

### 2. `previewDeposit` — worst-case floor formula

`previewDeposit(assets)` **must** return the worst-case floor of shares
minted for `assets` USDC deposited:

```
afterSlippage = assets × (MAX_BPS − maxSlippageBps) / MAX_BPS   (floor division)
floor = convertToShares(afterSlippage)                           (floor division)
```

The deposit path routes `assets` into basket swaps; under worst-case slippage
the actual USDC converted into basket tokens is `assets × (1 −
maxSlippageBps / 10_000)`. Shares are minted proportional to the resulting
basket value, so the floor is shares for the slippage-reduced notional.

### 3. `previewWithdraw` — unchanged rounding, slippage applied

`previewWithdraw(assets)` returns the **ceiling** shares a caller must burn to
receive at least `assets` USDC net. The slippage factor means the vault must
sell proportionally more; adjust as:

```
grossNeeded = assets / (1 − exitFeeBps / MAX_BPS)    (ceiling division)
grossWithSlippage = grossNeeded / (1 − maxSlippageBps / MAX_BPS)  (ceiling division)
ceiling = convertToShares(grossWithSlippage)          (ceiling division)
```

### 4. ERC-4626 conformance note

BasketVault is **not fully ERC-4626 conformant** in the sense that `redeem`
does not return a deterministic `assets` value equal to `previewRedeem`.
The ERC-4626 guarantee is met as a *floor*: actual output ≥ `previewRedeem`.
The vault discloses this in the following ways:

1. **NatSpec on `previewRedeem`** — must include the note:

   > Returns a worst-case floor, not an exact quote. Actual USDC received
   > equals the floor or more; it may exceed this value when swap execution
   > beats the slippage bound. The floor is `grossNAV × (1 − maxSlippageBps)
   > × (1 − exitFeeBps)`.

2. **NatSpec on `_withdraw`** — must reference `previewRedeem` as the
   lower bound and note that actual output is determined by swap execution.

3. **Router disclosure** — the Portfolio Router must read `previewRedeem`
   and treat the return value as the minimum leg output. The router must NOT
   use spot NAV (without slippage adjustment) to compute allocation legs for
   basket vault redemptions.

4. **`maxSlippageBps` is a public state variable** — the front-end dApp and
   `rmpc` read it to display the worst-case range to depositors before they
   sign.

### 5. Relationship to `amountOutMinimum`

The per-swap `amountOutMinimum` computed inside `_routeDeposit` and
`_sellProportional` uses the same `maxSlippageBps` factor applied to the
TWAP-based (post-oracle-ADR) or slot0-based (current) per-token quote.
`previewRedeem` aggregates this effect across all basket tokens as a single
portfolio-level floor. The per-token enforcement is stricter (each token swap
must individually meet its floor); the portfolio-level preview is a valid
conservative bound because slippage cannot exceed `maxSlippageBps` on any
individual leg.

### 6. Parameter governance

`maxSlippageBps` is admin-settable (capped at `MAX_SLIPPAGE_BPS`). Because
`previewRedeem` embeds `maxSlippageBps` in its return value, any admin update
to `maxSlippageBps` immediately changes the previewed floor for all callers.
The `MaxSlippageUpdated` event must be indexed by the explorer so that the
allocation-page can re-fetch the preview floor after each update.

## Consequences

**Positive.**

- `previewRedeem` / `previewDeposit` satisfy the ERC-4626 *floor*
  invariant: actual output ≥ preview floor, by construction from
  `amountOutMinimum`.
- The Portfolio Router can safely use `previewRedeem` as the minimum
  expected output for each basket leg without needing to know internal
  swap mechanics.
- Depositors and `rmpc` callers see the worst-case USDC floor before
  signing, fulfilling `docs/architecture.md` §8.
- No Solidity change is required to `_withdraw` or the swap helpers; the
  change is entirely in the preview view functions.

**Negative / accepted risks.**

- `previewRedeem` now returns less than the spot NAV, which may surprise
  callers who expect it to equal the "fair value" of the shares. The NatSpec
  disclosure (§4 above) is the mitigation.
- If `maxSlippageBps` is set very conservatively the previewed floor is
  far below actual execution. This is a UX trade-off accepted for safety.
- If the oracle is still slot0-based, the `grossAssets` component of the
  formula remains manipulable; the slippage correction does not eliminate
  oracle risk. The TWAP oracle ADR is still required for full router
  eligibility.

**Out of scope of this decision.**

- The TWAP oracle source for `grossAssets` — that is the TWAP Oracle ADR
  (Appendix A of `basket-vault-gap-report.md`).
- Rebalancing model — separate ADR (Appendix B of `basket-vault-gap-report.md`).
- Shortlist governance for AgentTokenVault — separate ADR (Appendix C).
- Liquidity proof per basket token — separate pre-registration process.
- The implementation change to `BasketVault.sol` — this ADR approves the
  formula; the Phase B implementation issue applies it.
