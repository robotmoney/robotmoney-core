# Issue — `get-vault` only surfaces the exit fee; management fee and swap-fee share are not observable

> Summary: PRD §5.4 states "all three rates — management fee, swap-fee share, exit fee — are observable through the vault's read surface." `get-vault` returns only `exitFeeBps`. The 2% annual management fee and the swap-fee share are absent. An agent computing its true net return will overstate yield because the management fee drag is invisible. `get-apy` returns gross yield from underlying protocols without subtracting the management fee. The website advertises three fees; the CLI exposes one. The root cause may be that the management fee's on-chain accrual mechanism is unknown — `docs/technical/smart-contracts.md` §5.4 documents three plausible implementations, none confirmed.

## 1. Severity

**Medium.** No command fails. But any agent or human using `get-vault` or `get-apy` to evaluate Robot Money's economics receives an incomplete picture. Net APY is overstated by the management fee. This is a material misrepresentation for a treasury-automation product whose users make allocation decisions based on yield data.

## 2. Background

PRD §5.4:
> "The protocol levies three distinct fees, each a parameter set by governance: management fee, swap-fee share, exit fee. All three rates are observable through the vault's read surface."

The website's product page lists all three fees explicitly and quantifies them (2% annual management, 40% of 1% swap fees, 0.25% exit). The CLI only surfaces the third.

`docs/technical/smart-contracts.md` §5.4 identifies the gap precisely:
> "Only the 0.25% exit fee is visible on-chain in the ABI. The 2% annual management fee mentioned on robotmoney.net is not a vault function the CLI calls. Three plausible implementations, none confirmable from this repo: (1) off-chain accounting via admin skims, (2) a `harvest()`/`accrueFees()` admin function not in the CLI ABI, (3) continuous accrual via an internal timestamp deducted on every read of `totalAssets()`."

This issue is distinct from a simple implementation gap — the on-chain mechanism may not be exposed in a readable form at all, in which case the CLI must surface what it knows and be explicit about what it doesn't.

## 3. Evidence

`packages/cli/src/commands/get-vault.ts`: reads `exitFeeBps` and `feeRecipient`. Output includes:

```json
{
  "exitFeeBps": 25,
  "feeRecipient": "0x88bA..."
}
```

No `managementFeeBps`. No `swapFeeBps`. No `annualFeeNote`.

`packages/cli/src/commands/get-apy.ts`: aggregates APY from Morpho GraphQL, Aave pool rate, and Compound utilisation rate. Returns a `blended` figure. No deduction of management fee. An operator reading `blended: "5.2%"` and not knowing the 2% management fee will expect 5.2% net; actual net is ~3.2%.

`packages/cli/src/lib/abi.ts`: no `managementFee`, `managementFeeBps`, `accrueFees`, `harvestFees`, or `swapFeeBps` function selectors.

## 4. Proposed resolution

### Track A — ABI investigation

Fetch the deployed vault bytecode via `eth_getCode` and attempt to match known fee-getter selectors (`managementFeeBps()` = `keccak256("managementFeeBps()")[:4]`, etc.). If a fee getter exists in the deployed contract but is absent from `lib/abi.ts`, add it. Document the outcome in `docs/technical/smart-contracts.md` §5.4.

This is a one-time investigation step that determines whether Track B can be fully on-chain or requires partial hardcoding.

### Track B — `get-vault` output

Extend `get-vault` to emit all three fees, with honest handling of the unknown:

**If management fee getter found on-chain:**
```json
{
  "exitFeeBps": 25,
  "managementFeeBps": 200,
  "swapFeeBps": 100,
  "feeRecipient": "0x88bA..."
}
```

**If management fee is not readable on-chain:**
```json
{
  "exitFeeBps": 25,
  "managementFeeBps": null,
  "swapFeeBps": null,
  "feeRecipient": "0x88bA...",
  "feeNote": "Management fee (2% annual) and swap-fee share are not exposed as on-chain getters. Rates are published at https://robotmoney.net. Contact the protocol admin for on-chain confirmation."
}
```

The `feeNote` field is better than silence — an LLM reading the output can surface it to the user rather than presenting an implicitly complete picture.

### Track C — `get-apy` net yield

Update `get-apy` to:
- If `managementFeeBps` is readable: return both `grossApy` (underlying protocols) and `netApy` (gross minus management fee annualised).
- If not readable: return `grossApy` and add a `apyNote: "Gross yield before management fee. Subtract ~2% annual for estimated net."` field.

Current output only has `blended`; rename to `grossApy` (with `blended` as a deprecated alias) to make the gross/net distinction explicit.

## 5. Acceptance criteria

- `get-vault` output includes `managementFeeBps`, `swapFeeBps` (either as integers or as `null` with a populated `feeNote`).
- `get-vault` never silently omits fee information — either the value is present, or `feeNote` explains why it isn't.
- `get-apy` returns `grossApy` and either `netApy` (if management fee is known) or `apyNote` (if not).
- `docs/technical/smart-contracts.md` §5.4 is updated with the result of the ABI investigation.
- `SKILL.md` is updated to note: when presenting APY to a user, always subtract the management fee; quote `netApy` if available, or apply the `~2%` deduction manually to `grossApy`.
- Unit test: mock a vault that returns `managementFeeBps = 200`; assert `get-vault` output includes it. Mock a vault that does not expose the function; assert `get-vault` output includes `feeNote` and does not error.

## 6. Open questions

- **Is the 2% management fee the right number?** The website states 2% annual; the vault ABI may expose a different figure if/when it's readable. The PRD treats fees as governance-settable parameters, so the website rate may already be outdated.
- **Swap-fee share mechanics.** The website states "40% of 1% swap fees." This implies a swap router charges a fee and the protocol takes 40% of it. Is this collected in the vault, or accrued separately? If separately, it may never be visible via `get-vault`.
- **`totalAssets()` and fee accrual.** If management fees are deducted on every `totalAssets()` read (implementation option 3 in `smart-contracts.md`), then `get-vault`'s `sharePrice` already reflects fee drag, and reporting `managementFeeBps` separately would cause double-counting in any NAV calculation. The relationship between fee accrual and `totalAssets()` must be documented before `get-apy` produces a `netApy` figure.

## 7. References

- Current `get-vault`: [`../../packages/cli/src/commands/get-vault.ts`](../../packages/cli/src/commands/get-vault.ts)
- Current `get-apy`: [`../../packages/cli/src/commands/get-apy.ts`](../../packages/cli/src/commands/get-apy.ts)
- Fee analysis: [`../technical/smart-contracts.md`](../technical/smart-contracts.md) §5.4
- PRD fee requirement: [`../prd.md`](../prd.md) §5.4
