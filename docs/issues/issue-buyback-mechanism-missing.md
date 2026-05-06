# Issue — Deterministic buyback-and-burn has no on-chain mechanism; Phase 5 deliverable unmet

> Summary: Phase 5 of the roadmap specifies "prop wallet realized gains wired to deterministic buyback-and-burn with published BaseScan receipts." The deployed vault has no buyback trigger, no connection to the prop wallet, and no burn mechanism. Buybacks currently described on the website (10 buybacks, ~$2,504) are manually executed by the admin from the prop wallet — they are not deterministic, not triggered by vault economics, and not wired to any on-chain rule.

## 1. Severity

**Low for fund safety; Medium for product completeness.** No depositor funds are at risk. The issue affects the $ROBOTMONEY token economics (supply reduction) and the credibility of the "deterministic buyback" claim. Until Phase 5, manual buybacks are the correct posture — the issue is that Phase 5 has no implemented upgrade path.

## 2. Background

Roadmap Phase 5:
> "Prop wallet realized gains wired to deterministic buyback-and-burn with published BaseScan receipts"
> "Target: $100K TVL with first completed allocation vote cycle"

Roadmap Phase 1 (completed):
> "Initial buybacks from prop wallet swap fee revenue (~10 buybacks, ~$2,500)"

Website ($ROBOTMONEY mechanics):
> "Protocol revenue funds buyback-and-burn of $ROBOTMONEY, producing supply reduction over time"

### What exists today

The website changelog and the website's buybacks page record ~10 manual buybacks executed by the prop wallet. These are regular Uniswap swaps — USDC or ETH → $ROBOTMONEY — done at admin discretion, with no on-chain rule enforcing when or how much.

The vault has no connection to the prop wallet. `feeRecipient` (the Safe multisig `0x88bA…75A0`) receives exit fees, but there is no on-chain rule that says "when exit fees accumulate to X, swap Y% for $ROBOTMONEY and burn it."

## 3. What "deterministic buyback-and-burn" requires

**Minimum viable (Phase 5):**
- A published, documented rule: e.g. "100% of exit fee accumulation above $500 is swapped for $ROBOTMONEY and sent to `address(0)` weekly." Rule is enforced by admin operating transparently per the published policy, with each buyback tx traceable on BaseScan.
- A `BuybackExecuted(uint256 usdcSpent, uint256 robotBurned)` event on-chain for auditability.

**Trustless (Phase 7+):**
- A `BuybackController` contract that receives exit fees, accumulates them, and at a trigger point (time, balance threshold, or governance call) swaps via Uniswap and sends $ROBOTMONEY to `address(0)`.
- No admin discretion required — the swap and burn happen automatically within the contract's parameters.

### Connection to fee routing

The vault's `exitFeeBps = 25` (0.25%) charges a fee to the Safe multisig `feeRecipient`. For buybacks to be automatic, either:
- `feeRecipient` is changed to the `BuybackController`, or
- The Safe periodically transfers accumulated exit fees to the `BuybackController`.

The first option is cleaner but requires trusting the `BuybackController` contract. The second keeps the Safe as the last line of defence.

## 4. CLI gap

Buyback state is not observable via any CLI command. The website tracks buybacks on a dedicated page; the CLI has no `get-buybacks` or similar command. For an autonomous treasury agent to know whether a buyback has occurred (and thus that $ROBOTMONEY supply has decreased), it currently has no programmatic path. This could be added as a simple `get-buybacks` read command that queries `BuybackExecuted` events once the contract exists.

## 5. Acceptance criteria

- A documented and published buyback policy stating the trigger condition, the amount formula, and the target address (`address(0)` burn or a verifiable burn address).
- Each buyback has a verifiable on-chain tx linked from the website's buyback log.
- When the `BuybackController` is deployed, `feeRecipient` is updated or an admin transfer process is defined.
- A `get-buybacks` CLI read command queries `BuybackExecuted` events and returns recent buyback history with USDC spent, $ROBOTMONEY burned, and block timestamps.

## 6. References

- Roadmap Phase 5: https://www.robotmoney.net/changelog
- Vault exit fee: [`../../contracts/RobotMoneyVault.sol`](../../contracts/RobotMoneyVault.sol) `exitFeeBps`, `feeRecipient`
- $ROBOTMONEY token address (also ROBOT basket token): [`../../packages/cli/src/lib/basket/constants.ts`](../../packages/cli/src/lib/basket/constants.ts)
