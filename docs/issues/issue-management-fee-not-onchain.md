# Issue — Management fee is a Phase 4 deliverable but is absent from the deployed vault

> Summary: The Phase 4 roadmap entry explicitly lists "Management fee structure: 2% annual, daily accrual" and "Management fee sweep wired to prop wallet" as deliverables for the initial vault deployment. The deployed `RobotMoneyVault` contract contains no management fee mechanism — no state variable, no accrual timestamp, no `harvest()`, no `accrueFees()`, no automatic sweep. The only on-chain fee is the 0.25% exit fee. The management fee is being described to depositors on the website as a live fee; it is not enforced by the contract.

## 1. Severity

**High.** Phase 4 claims the management fee is deployed. It is not. Depositors reading the website believe a 2% annual management fee exists and is enforced; the contract does not enforce it. This is a discrepancy between advertised economics and on-chain reality.

## 2. Background

Roadmap Phase 4:
> "Management fee structure: '2% annual, daily accrual' and '0.25%' exit fee"
> "Management fee sweep wired to prop wallet"

Website product page:
> "2% annual management fee (0.00548%/day)"

Confirmed from `contracts/RobotMoneyVault.sol`: the only fee mechanism is `exitFeeBps` (set to 25 bps, i.e. 0.25%). There is no:
- `managementFeeBps` state variable
- `lastFeeAccrual` timestamp
- `accrueFees()` or `harvest()` function
- Any `_beforeDeposit` / `_afterDeposit` hook that deducts a time-based fee

`exitFeeBps` has a hardcoded ceiling of `MAX_EXIT_FEE_BPS = 100` (1%), so even if `setExitFeeBps` were used as a workaround, it cannot express a 2% annual charge.

## 3. Options for implementation

**Option A — Daily admin-initiated sweep (off-chain, no contract change)**
Admin periodically calls `rescueTokens` or arranges a direct fee transfer. This is likely what is happening today informally. Not trustless; depends on admin action; not visible to depositors reading the contract.

**Option B — Continuous accrual via `totalAssets()` override**
Override `totalAssets()` to deduct a continuously-accruing fee based on `block.timestamp - lastFeeAccrual`. Fee is "invisible" in the sense that share price grows more slowly. This is the Yearn V3 / ERC-4626 canonical approach.

**Option C — Explicit periodic harvest function**
Add `accrueFees()` callable by ADMIN or KEEPER: mints fee shares to `feeRecipient` proportional to time elapsed since `lastFeeAccrual`. Transparent — on-chain event emitted each time.

Option B is most common for ERC-4626 vaults (least gas overhead per depositor), but it requires the contract to be redeployed or upgraded since there is no upgrade path in the current contracts. Option A is the immediate pragmatic answer; Option C is what a future vault version should implement.

## 4. Impact on CLI and SKILL

`get-vault` and `get-apy` currently report only the exit fee. If a management fee is implemented (any option), the CLI must surface it — see `issue-get-vault-fees-incomplete.md`. The `get-apy` command must report net APY after management fee.

## 5. Acceptance criteria

- The on-chain fee mechanism matches what is advertised on the website (2% annual, daily accrual, or a clearly documented equivalent).
- `get-vault` output includes `managementFeeBps` (or equivalent).
- `get-apy` reports `netApy` as `grossApy − managementFee`.
- If Option A (off-chain) is chosen as the permanent answer, `docs/technical/smart-contracts.md` and the website must be updated to say "management fee is collected off-chain via admin transactions" rather than implying it is automatically deducted.

## 6. References

- Roadmap Phase 4: https://www.robotmoney.net/changelog
- Vault source: [`../../contracts/RobotMoneyVault.sol`](../../contracts/RobotMoneyVault.sol)
- CLI fee gap: [`issue-get-vault-fees-incomplete.md`](issue-get-vault-fees-incomplete.md)
