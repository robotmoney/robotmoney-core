# Security Review: Robot Money — Branch `lucky/security-review`

**Scope:** Full codebase — `contracts/` (Solidity), `packages/cli/src/` (TypeScript), shell scripts, config  
**Method:** Breadth-first codebase survey → drill-down per call path → parallel false-positive filtering  
**Threshold:** Only findings with exploitation confidence ≥ 8 are reported

---

## Result: No High-Confidence Vulnerabilities Found

After exhaustive analysis across all call paths, every candidate finding was filtered out. The contracts and off-chain code are more carefully written than the breadth-first scan suggested.

---

## What Was Examined and Why It Is Not Exploitable

### Smart Contracts

**`_withdraw` CEI order — `_pullProportional` before `_burn`**
Shares are burned after external adapter calls. With `nonReentrant` on `_withdraw`, adapters cannot reenter. No exploitable reentrancy path exists. *(Confidence after filtering: 4)*

**`MorphoAdapter.withdraw` returns `amount` not `actual`**
`MORPHO_VAULT.withdraw(amount, VAULT, address(this))` is an ERC-4626 call that MUST revert if it cannot transfer `amount`. Unlike Aave (which returns a value) and Compound (which sends to `msg.sender` so a pre/post balance diff is required), Morpho sends directly to `VAULT` and reverts on shortfall by spec. Returning `amount` is correct. *(Confidence after filtering: 2)*

**`adminRebalance` with no target-sum validation**
The second loop is bounded by `idle` USDC actually in the vault — not by `targetBalances`. Admin cannot over-allocate beyond what was pulled. Funds stay within the vault system. *(Confidence after filtering: 4)*

**`totalAssets()` excludes vault idle USDC → TVL cap can be marginally exceeded**
True accounting gap, but: (a) idle USDC is swept on every `rebalance()` call, (b) the overshoot window is bounded by `perDepositCap`, (c) no theft path — if anything, new depositors receive slightly fewer shares (existing holders benefit). The TVL cap is an administrative parameter, not a solvency invariant. *(Confidence after filtering: 2)*

**`_pullProportional` rounding remainder**
The final `remaining` after proportional pulls is at most a few wei (integer division loss). The last adapter's balance easily covers it. *(Confidence after filtering: 3)*

### Off-Chain / TypeScript

**OWS wallet created without spending policy**
The `OwsCore` interface has no policy parameter — caps are not set at wallet creation. This is a documented gap (`issue-ows-policy-unenforced.md`) and a missing hardening layer, but it is not a *concrete exploitable vulnerability* in the implemented code. Rule 7 applies: "code is not expected to implement all security best practices, only flag concrete vulnerabilities." *(Confidence after filtering: 3)*

**V4 sell path `amountOutMin = 0n` on intermediate WETH leg**
The `minUsdcOut` is computed from the full end-to-end simulated path output and enforced on the final V3 leg via `V3_CONTRACT_BALANCE`. Uniswap's Universal Router executes both commands atomically — there is no partial-fill state. A V4 sandwich that pushes the V3 output below `minUsdcOut` causes a clean revert (gas loss only, excluded per DOS rule). Any sandwich that clears the floor means the user received their stated minimum. *(Confidence after filtering: 2)*

**USDC allowance storage slot hardcoded (`slot 10`)**
The comment documents on-chain verification. A wrong slot only affects `stateOverride` during gas estimation — not actual transaction execution. The real deposit/approve sequence works regardless. Impact: misleading simulation output, not fund loss. *(Confidence after filtering: 5)*

**RPC URL from `process.env.RPC_URL` without validation**
Environment variables are trusted values per standard precedent — excluded. *(Auto-excluded)*

---

## Near-Threshold Design Observations (Not Vulnerabilities)

These are worth knowing but do not meet the reporting bar:

1. **`MorphoAdapter.withdraw` inconsistency** — Aave and Compound verify actual received amounts; Morpho does not because ERC-4626 semantics differ. Defensive depth would improve consistency but cannot be exploited.

2. **`totalAssets()` excludes vault idle USDC** — A single-line fix (`+ IERC20(asset()).balanceOf(address(this))`) would make the TVL cap accounting exact and would also improve share price accuracy during rebalance windows.

3. **V4 sell intermediate minimum asymmetry** — The buy path enforces `intermediateMin` on the V3 leg; the sell path does not. Adding a derived WETH floor from `hopOutputs[0]` would make the two paths symmetric and reduce gas waste from reverts in volatile markets.

---

## Summary

The contracts are well-structured: `ReentrancyGuard` on all state-mutating paths, `SafeERC20` throughout, `onlyVault` on all adapters, no unchecked external call return paths that can be forced into a bad state. The off-chain code correctly handles nonce sequencing, gas estimation fallbacks, and slippage on the final output of each swap path.

No exploitable vulnerabilities at confidence ≥ 8 were identified in the current codebase.
