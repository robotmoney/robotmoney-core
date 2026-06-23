# Contract Security Remediation — Dev Scout

> Reference: [Smart-Contract Vulnerability Audit 2026-06-09](../code-review/20260609-code-review-internal-claude.md)
> Phase: Contract security remediation (phase/contract-security-remediation)
> Scout issue: #745

## 1. Per-file ownership map

Which issues touch which files. Issues within the same file group must serialize
so they do not conflict on overlapping edits. Files with a single owner need no
serialization but the owning issue must merge before the sweep (#757) can touch
the same file.

| File | Issues | Conflict group |
|------|--------|----------------|
| `contracts/vaults/BasketVault.sol` | #746 (H-1), #750 (M-4), #754 (M-8), #757 (L-15–17) | **csr/basket-vault** |
| `contracts/vaults/RwaVault.sol` | #750 (M-4), #747 (M-1 test surface) | csr/basket-vault → csr/isolated |
| `contracts/RobotMoneyVault.sol` | #748 (M-2), #749 (M-3), #757 (L-1–4) | **csr/vault-core** |
| `contracts/PortfolioRouter.sol` | #751 (M-5), #756 (M-10 test surface), #757 (L-8–11) | csr/isolated → csr/governance |
| `contracts/RouterGovernance.sol` | #755 (M-9), #756 (M-10), #757 (L-10) | **csr/governance** |
| `contracts/gateway/RobotMoneyGateway.sol` | #752 (M-6), #753 (M-7), #757 (L-12–13) | **csr/gateway** |
| `contracts/gateway/AccessRoles.sol` | #757 (L-14) | csr/sweep (sole owner) |
| `contracts/adapters/ChronicleOracleAdapter.sol` | #747 (M-1), #757 (L-5, L-7) | csr/isolated → csr/sweep |
| `contracts/adapters/UniswapV4SwapAdapter.sol` | #757 (L-5, L-6) | csr/sweep (sole owner) |
| `contracts/adapters/AerodromeSwapAdapter.sol` | #757 (L-5, L-7) | csr/sweep (sole owner) |
| `contracts/test/RwaVault.t.sol` | #747, #750 | csr/isolated ← csr/basket-vault (shared test file) |

### Serialization rules

1. **Within a group**: issues in the same conflict group must merge in order
   (listed above). Later issues in the group touch files already modified by
   earlier ones.
2. **Across groups**: groups are parallel-safe — they edit disjoint file sets
   except for cross-group test file sharing (RwaVault.t.sol is shared between
   #747 and #750; handle via rebase or merge-order).
3. **Sweep (#757)**: runs last across all groups. It reads the final state of
   every touched file.

## 2. Residual finding verification

Audit findings noted as "residuals in already-merged work" were verified against
`dev` HEAD (`1d308499`). Each still reproduces at the cited location:

| Issue | Finding | File | Audit line | Current line | Reproduces? |
|-------|---------|------|------------|--------------|-------------|
| #746 | H-1: `mint()` bypasses slippage entry haircut | `BasketVault.sol` | L457–462 | L457–462 | ✅ No `previewMint` override exists. |
| #749 | M-3: `forceRemoveAdapter` leaves deposits open | `RobotMoneyVault.sol` | L791–796 | L791–797 | ✅ No `_setDepositsPaused(true)` call present. |
| #751 | M-5: `redeemFor` permissionless confused-deputy | `PortfolioRouter.sol` | L470–503 | L470–503 | ✅ No access control on `redeemFor`. |
| #752 | M-6: Gateway ~2× burst across anchor reset | `RobotMoneyGateway.sol` | L291–322 | L291–322 | ✅ Single anchored bucket, no sliding window. |
| #753 | M-7: Commit/reveal bypassable via open `authorizeAgent` | `RobotMoneyGateway.sol` | L346–406 | L346–406 | ✅ Direct `authorizeAgent` at L383 remains callable. |
| #756 | M-10: Governance fully admin-controlled, no vote snapshot | `RouterGovernance.sol` | L257–263, L382–395 | L257–263, L382–395 | ✅ `votingPower` read live, `setVotingPower` admin-only, `setWeights` bypasses governance. |

All six residuals confirmed present on the current branch tip. Line-number
offsets are within ±2 lines of the audit citations (minor whitespace/doc changes
since the audits were written).

## 3. Net-new finding verification

| Issue | Finding | File | Audit line | Current line | Reproduces? |
|-------|---------|------|------------|--------------|-------------|
| #747 | M-1: ChronicleOracleAdapter no zero-price guard | `ChronicleOracleAdapter.sol` | L189–203 | L189–203 | ✅ No `navPrice == 0` check. |
| #748 | M-2: `withdraw(maxWithdraw(owner))` reverts under exit fee | `RobotMoneyVault.sol` | L439–449, L474–481 | L439–449, L474–481 | ✅ `_grossToNet` floors, `_netToGross` ceils — asymmetric. |
| #750 | M-4: Emergency unwind bypasses Chronicle staleness | `BasketVault.sol` | L754–769, L781–804 | L754–769, L781–804 | ✅ `_twapUsdcValue` called directly, not via `_checkOracleFreshness`. |
| #754 | M-8: `BasketVault.withdraw` violates ERC-4626 exactness | `BasketVault.sol` | L465–470, L475–504 | L465–470, L475–504 | ✅ `_withdraw` discards `assets` param, uses proportional swap proceeds. |
| #755 | M-9: Governance execution delay has no minimum | `RouterGovernance.sol` | L247–251 | L248–251 | ✅ `setExecutionDelay` has no floor check. |

All five net-new findings confirmed present.

## 4. Stub / seam notes

Each feature issue below describes the minimal entry-point seam. Implementation
issues should reference these entry points when writing their PRs.

### #746 — H-1: Override `BasketVault.previewMint`

**Seam:** Add `function previewMint(uint256 shares) public view override returns (uint256)`
in `BasketVault.sol` adjacent to `previewDeposit` (~L457). Gross the assets up:
`shares.convertToAssets(Ceil).mulDiv(MAX_BPS, MAX_BPS - maxSlippageBps, Ceil)`.
Alternatively, `revert` to force deposit-only.

**Dependency:** Owns `BasketVault.sol` — #750 and #754 must rebase after this.

### #747 — M-1: Reject zero Chronicle NAV price

**Seam:** Add `if (navPrice == 0) revert ZeroNavPrice()` after `latestAnswer()`
(~L189 in `ChronicleOracleAdapter.sol`). Optionally add configurable min/max
NAV bounds. Test via `RwaVault.t.sol`.

**Dependency:** Independent; test file shared with #750.

### #748 — M-2: Fix `maxWithdraw` round-trip under exit fee

**Seam:** In `RobotMoneyVault.sol` (~L447), compute `maxWithdraw` as the largest
`net` such that `previewWithdraw(net) ≤ balanceOf(owner)`. Binary search or
iterative approach. Add fee-enabled conformance test cases to
`RobotMoneyVault4626Conformance.t.sol`.

**Dependency:** Depends on #749 (same file, `forceRemoveAdapter` lands first).

### #749 — M-3: Pause deposits in `forceRemoveAdapter`

**Seam:** Add `_setDepositsPaused(true)` at the end of `forceRemoveAdapter`
(~L796 in `RobotMoneyVault.sol`), before the event emit.

**Dependency:** First in csr/vault-core group.

### #750 — M-4: Enforce Chronicle freshness on emergency-unwind floors

**Seam:** In `BasketVault.sol`, add a `_requireOracleFreshness()` modifier or
inline check at the top of `emergencyUnwind` (~L754) and
`emergencyUnwindWithOverride` (~L781). Call `RwaVault._checkOracleFreshness()`
via the RWA vault instance, or duplicate the staleness check. Add an
EMERGENCY_ROLE override flag if stale-price forced exit is intended.

**Dependency:** Depends on #746 (same file).

### #751 — M-5: Gate `redeemFor` to authorized callers

**Seam:** Add `require(msg.sender == shareHolder, "not authorized")` at the top
of `redeemFor` (~L470 in `PortfolioRouter.sol`), or maintain an
authorized-caller allowlist. Update NatSpec.

**Dependency:** Independent (csr/isolated group).

### #752 — M-6: Close gateway ~2× rolling-window burst

**Seam:** Replace single anchored bucket in `_accrueRollingWithdraw` (~L291) and
`_accrueRollingDeposit` (~L310) with a true sliding window (sub-buckets or
timestamp ring buffer) in `RobotMoneyGateway.sol`. Alternatively, document the
cap as ≤2×.

**Dependency:** Depends on #753 (same file, commits first in csr/gateway group).

### #753 — M-7: Make commit/reveal the sole `authorizeAgent` path

**Seam:** Remove or gate the direct `authorizeAgent` function (~L383) so
first-time authorization always goes through commit/reveal. Bind the reveal so
agent address is not learnable before ownership finalizes.

**Dependency:** First in csr/gateway group.

### #754 — M-8: Honor ERC-4626 withdraw exactness in BasketVault

**Seam:** In `BasketVault.sol`, either (a) make `withdraw` deliver at least
`assets` (sell extra shares to cover slippage, revert if not possible) and
reflect slippage in `previewWithdraw`; or (b) revert in both `withdraw` and
`previewWithdraw` to force redeem-only exits.

**Dependency:** Depends on #750 (same file, which depends on #746).

### #755 — M-9: Enforce `MIN_EXECUTION_DELAY` in RouterGovernance

**Seam:** Add `uint64 public constant MIN_EXECUTION_DELAY = 1 days` (or similar)
in `RouterGovernance.sol`. Check `delay >= MIN_EXECUTION_DELAY` in both the
constructor (~L223) and `setExecutionDelay` (~L248).

**Dependency:** Depends on #756 (same file, csr/governance group).

### #756 — M-10: Snapshot voting power at proposal creation

**Seam:** In `RouterGovernance.sol`, capture `votingPower[msg.sender]` into
`Proposal.power` at `propose()` time (~L344). Change `vote()` to read
`proposal.power` instead of live `votingPower[msg.sender]`. Document that only
RouterGovernance holds the router's ADMIN_ROLE.

**Dependency:** First in csr/governance group.

### #757 — Low-severity hardening sweep

**Seam:** Runs last across all groups. Edits every touched file (see ownership
map). Each L fix is small and isolated:
- L-1: Add `if (withdrawalsPaused) return 0` to `maxWithdraw`/`maxRedeem`
- L-2: Iterate remaining adapters capping each pull at `min(remaining, balance)`
- L-3: Restrict `shutdownVault` to `ADMIN_ROLE` or make two-step
- L-4: Skip ineligible adapters in `_routeDeposit`
- L-5: Plumb caller-chosen `deadline` through swap adapters
- L-6: Use `SafeCast.toUint128`
- L-7: Assert `amounts.length >= 1`
- L-8: Add `minAssetsPerLeg` and `deadline` to `redeemFor`
- L-9: Reject duplicate vault entries
- L-10: Prevent dropping the last admin
- L-11: Pin `rescueUsdc` recipient to fixed treasury
- L-12: Add `OP_WITHDRAW_ROUTER` prefix
- L-13: Pull shares from `shareReceiver`, not agent
- L-14: Include `DEFAULT_ADMIN_ROLE` in role-disjointness check
- L-15: Skip inactive entries in `rescueTokens`
- L-16: Override `maxDeposit`/`maxMint` to reflect caps/shutdown/pause
- L-17: Add sane lower floor for `setMaxSlippageBps`

## 5. Integration risks

- **RwaVault.t.sol** is shared between #747 (csr/isolated) and #750
  (csr/basket-vault). #750 merges first; #747 must rebase.
- **Contracts/doc/src/** (generated doc source) may shift after Solidity changes;
  feature issues should regenerate and include updated doc files.
- **`setWeights`/`setDefaultWeights`** in PortfolioRouter can bypass governance
  entirely via ADMIN_ROLE. #756 or #757 should address this.
