# Verification of Security Code Review Findings

**Date:** 2026-07-28
**Commit:** 43694310dff645a7bdf473de82dd340c41a86e34 (same as original review)
**Source review:** `docs/code-review/20260728-code-review-internal-kimi.md`
**Method:** Read every cited code location at the pinned commit; verified claims against actual code.

---

## Verdict Summary

| Verdict | Count | Findings |
|---------|-------|----------|
| CONFIRMED | 18 | All HIGH, 10 of 11 original MEDIUM, 1 new MEDIUM (review-security-m-012) |
| REFUTED | 1 | review-security-m-006 (VaultRegistry empty-code skip) |
| PARTIALLY CONFIRMED | 0 | — |

---

## HIGH SEVERITY — All 7 CONFIRMED

### review-security-h-001: RobotMoneyVault pause() blocks withdrawals — CONFIRMED

**Claim:** `pause()` sets `withdrawalsPaused = true`, blocking all redemptions.

**Evidence:**
- `contracts/RobotMoneyVault.sol:890-893`:
  ```solidity
  function pause() external onlyRole(EMERGENCY_ROLE) {
      _setDepositsPaused(true);
      _setWithdrawalsPaused(true);
  }
  ```
- `contracts/RobotMoneyVault.sol:596`: `if (withdrawalsPaused) revert WithdrawalsPaused();` — in the withdraw path.
- `contracts/test/RobotMoneyVault.t.sol:1080`: `assertTrue(vault.withdrawalsPaused(), "withdrawals must be paused");` — test confirms behavior.
- PRD §12 INV-3: "withdrawals are never blocked."
- Vault.sol (v2) fixes this by making `pause()` deposits-only.

**Verdict:** CONFIRMED. `pause()` on RobotMoneyVault blocks both deposits and withdrawals. The fix exists in Vault.sol but is not backported.

---

### review-security-h-002: ISwapRouter missing `deadline` — CONFIRMED

**Claim:** `ISwapRouter.ExactInputSingleParams` has 7 fields; real SwapRouter02 uses 8 fields (including `deadline`).

**Evidence:**
- `contracts/interfaces/ISwapRouter.sol:8-16`:
  ```solidity
  struct ExactInputSingleParams {
      address tokenIn;
      address tokenOut;
      uint24 fee;
      address recipient;
      uint256 amountIn;
      uint256 amountOutMinimum;
      uint160 sqrtPriceLimitX96;
  }
  ```
  — 7 fields, no `deadline`.
- Real SwapRouter02 on Base mainnet (`0x2626664c2603336E57B271c5C0b26F421741e481`) uses:
  ```solidity
  struct ExactInputSingleParams {
      address tokenIn;
      address tokenOut;
      uint24 fee;
      address recipient;
      uint256 deadline;      // ← MISSING in local interface
      uint256 amountIn;
      uint256 amountOutMinimum;
      uint160 sqrtPriceLimitX96;
  }
  ```
- `contracts/vaults/BasketVault.sol:1666-1679` calls `SWAP_ROUTER.exactInputSingle(...)` with the 7-field struct.

**Impact analysis:** When the 7-field calldata reaches the 8-field decoder, the ABI reads `deadline` from the offset where `amountIn` is, `amountIn` from where `amountOutMinimum` is, and `amountOutMinimum` from where `sqrtPriceLimitX96` is. The swap would attempt to swap `amountOutMinimum` (a small number) instead of `amountIn`, with no slippage protection. Every default-V3-path call on mainnet would either revert or route corrupted amounts.

**Verdict:** CONFIRMED. ABI mismatch is genuine. ProtocolAssetVault and AgentTokenVault BNKR leg are dead-on-arrival for mainnet via the default V3 path.

---

### review-security-h-003: ORA-7 same-source TWAP — CONFIRMED

**Claim:** Slippage floor derived from the same TWAP that prices NAV.

**Evidence:**
- `contracts/vaults/BasketVault.sol:1174-1181`:
  ```solidity
  function _slippageFloor(AssetInfo memory assetInfo, uint256 amount)
      internal view returns (uint256)
  {
      return _applySlippage(
          _twapUsdcValue(assetInfo.pool, assetInfo.token, assetInfo.adapter, amount)
      );
  }
  ```
  `_twapUsdcValue` is the same function used for NAV pricing.
- `contracts/test/fv/TwapManipulation.t.sol:82-86`: "Fails on current HEAD because `_slippageFloor → _twapUsdcValue` is the NAV TWAP itself (no independent backstop)."

**Verdict:** CONFIRMED. Slippage floor and NAV use the same TWAP source. Known issue tracked as #966.

---

### review-security-h-004: RwaVault stale feed blocks redemptions — CONFIRMED

**Claim:** `totalAssets()` calls `_checkOracleFreshness()` which reverts when feed is stale, blocking `redeem()`.

**Evidence:**
- `contracts/vaults/RwaVault.sol:209-214`:
  ```solidity
  function totalAssets() public view override returns (uint256) {
      if (_holdsPricedRwa()) {
          _checkOracleFreshness();
      }
      return super.totalAssets();
  }
  ```
- `_holdsPricedRwa()` short-circuit (line 210-211) only exempts the idle-USDC state.
- While any deSPXA balance exists, stale feed → `totalAssets()` reverts → `redeem()` reverts.
- ADR-0006 §2: "A stale oracle halts deposits AND withdrawals."
- PRD §12 INV-3: "withdrawals are never blocked." — direct contradiction.

**Verdict:** CONFIRMED. Documentation conflict between PRD and ADR-0006. RWA is Router-eligible per PRD §11.4.

---

### review-security-h-005: RobotMoneyVault lacks last-admin-floor — CONFIRMED

**Claim:** RobotMoneyVault uses plain `AccessControl`, not `AdminFloorAccessControl`.

**Evidence:**
- `contracts/RobotMoneyVault.sol:26`:
  ```solidity
  contract RobotMoneyVault is ERC4626, AccessControl, ReentrancyGuard {
  ```
- `contracts/PortfolioRouter.sol:41`: `contract PortfolioRouter is AdminFloorAccessControl, ReentrancyGuard {`
- `contracts/VaultRegistry.sol:62`: `contract VaultRegistry is AdminFloorAccessControl {`
- `contracts/RouterGovernance.sol:40`: `contract RouterGovernance is AdminFloorAccessControl, ReentrancyGuard {`
- `contracts/Vault.sol` (v2) also enforces last-admin floor.
- BasketVault enforces last-admin floor via `adminCount` tracking (lines 63-88).

**Verdict:** CONFIRMED. RobotMoneyVault is the only fund-holding contract without last-admin-floor protection.

---

### review-security-h-006: DeployTimelock never grants ADMIN to RouterGovernance — CONFIRMED

**Claim:** DeployTimelock grants ADMIN_ROLE on PortfolioRouter to TimelockController and revokes from deployer, but never grants ADMIN_ROLE to RouterGovernance.

**Evidence:**
- `contracts/script/DeployTimelock.s.sol:300-309`:
  ```solidity
  IAccessControl(d.router).grantRole(ADMIN_ROLE, address(timelock));
  // ...
  IAccessControl(d.router).revokeRole(ADMIN_ROLE, msg.sender);
  ```
  Grants ADMIN to timelock, revokes from deployer. No grant to RouterGovernance.
- `contracts/PortfolioRouter.sol:300-302`: `setWeights` is `onlyRole(ADMIN_ROLE)`.
- `contracts/RouterGovernance.sol:496`: `router.setWeights(p.vaults, p.bps);` — requires ADMIN_ROLE on router.
- `contracts/test/RouterGovernance.t.sol:123`: "Grant governance contract ADMIN_ROLE on the router so it can call setWeights." — done manually in test setUp.
- `contracts/test/DeployTimelock.t.sol:159`: Only checks `hasRole(ADMIN_ROLE, address(d.timelock))` on governance — does NOT check governance has ADMIN_ROLE on router.

**Verdict:** CONFIRMED. After DeployTimelock, `RouterGovernance.execute()` → `router.setWeights()` → reverts `AccessControlUnauthorizedAccount`. All governance weight updates bricked.

---

### review-security-h-007: Audits.md stale for 8 fixed findings — CONFIRMED

**Claim:** 8 Critical/High findings listed as "accepted-with-rationale" with no remediation PR are actually code-fixed at HEAD.

**Evidence:**
- `docs/audits.md:386-402` shows AZ-GW-1, AZ-BSK-1, AZ-RTR-2, AZ-BSK-2, AZ-BSK-3, AZ-BSK-5, AZ-REG-1, FS-RTR-1 as `accepted-with-rationale` with `—` in "Remediated by (PR)".
- Worker G verified all 8 are code-fixed at HEAD (PRs #1084, #1093, #1098, #1099, #1092).

**Verdict:** CONFIRMED. Stale ledger misleads future reviewers.

---

## MEDIUM SEVERITY — 11 of 12 CONFIRMED, 1 REFUTED

### review-security-m-001: Timelock ADMIN bypass on router — CONFIRMED

**Evidence:** DeployTimelock.s.sol:300 grants ADMIN_ROLE on PortfolioRouter to TimelockController. Safe (PROPOSER+EXECUTOR) can schedule operations through timelock to call `router.setWeights()` directly, bypassing governance voting.

**Verdict:** CONFIRMED. Undocumented escape path exists.

---

### review-security-m-002: Missing custodiedTokens() on IPositionAdapter — CONFIRMED

**Evidence:**
- `contracts/interfaces/IPositionAdapter.sol` has no `custodiedTokens()` function (confirmed by grep — functions are: `deploy`, `withdraw`, `totalAssets`, `isExact`, `harvestRewards`, `sweepForeignToken`, `USDC`, `VAULT`).
- `contracts/Vault.sol:1584-1589`: `sweepForeignToken` checks `protectedToken[token]` mapping.
- `Vault.addAdapter` does not auto-protect adapter custodied tokens.

**Verdict:** CONFIRMED. INV-2 risk window during adapter onboarding.

---

### review-security-m-003: Emergency floor hardcoded 0 — CONFIRMED

**Evidence:**
- `contracts/Vault.sol:1295`: `try adpt.withdraw(balance, 0)` — passes 0 as minUsdcOut.
- `contracts/Vault.sol:1340`: `try adpt.withdraw(balance, 0)` — passes 0 as minUsdcOut.

**Verdict:** CONFIRMED. No vault-stored emergency floor.

---

### review-security-m-004: V4 adapter architecture incompatible — CONFIRMED

**Evidence:**
- `contracts/interfaces/IUniswapV4Pool.sol` defines `token0()`, `observe()`, `slot0()`, `liquidity()` as standalone contract methods.
- `contracts/test/UniswapV4AssetPositionAdapter.t.sol:17-25`: "official uniswap v4-core keeps all pools as entries inside the singleton PoolManager (keyed by PoolId/PoolKey), not as standalone contracts exposing token0()/observe()/slot0()/liquidity() the way this repo's IUniswapV4Pool/IUniswapV4SwapRouter seam models them — a documented architecture gap."

**Verdict:** CONFIRMED. Architecture is incompatible with real Uniswap V4.

---

### review-security-m-005: V4 fork test uses mock pool — CONFIRMED

**Evidence:**
- `contracts/test/UniswapV4AssetPositionAdapter.t.sol:25-34`: "this fork test deploys the SAME mock V4 router/pool harness as the demo four-vault suite"

**Verdict:** CONFIRMED. V4 core functionality never exercised against real V4 in CI.

---

### review-security-m-006: VaultRegistry empty-code skip — REFUTED

**Claim:** `setVaultStatus` silently skips vault hook when `vault.code.length == 0`. Registry status says Retired but vault deposits not halted.

**Counter-evidence:**
- `contracts/VaultRegistry.sol:349-355`:
  ```solidity
  if (vault.code.length > 0) {
      if (newStatus == VaultStatus.Active) {
          IRetirableVault(vault).unretire();
      } else {
          IRetirableVault(vault).retire();
      }
  }
  ```
- The skip only applies when `vault.code.length == 0` — meaning the address has no deployed code.
- An address with no code cannot receive deposits (it's an EOA or an empty address). There are no deposits to halt.
- The comment at lines 342-348 explicitly states: "Every vault type in the protocol implements IRetirableVault; a registered address that lacks the hook fails the call intentionally." — the hook failure propagates for contracts WITH code (per AZ-REG-1 fix), and the empty-code skip is only for addresses with no code at all.
- On Cancun (the project's EVM), selfdestruct only works in the same transaction as creation, so a deployed contract cannot lose its code post-deployment.

**Verdict:** REFUTED. The empty-code skip is harmless — an address without code cannot receive deposits. The registry status being "Retired" for an EOA is a data quality issue (registering an EOA as a vault), not a security gap. The original finding's impact statement ("deposits not halted") is misleading: there are no deposits to halt on an address with no code.

**Residual note:** `registerVault` does not check code length, so an EOA can be registered as a vault. This is a data quality issue, not a security issue. A `require(vault.code.length > 0)` check in `registerVault` would be a hygiene improvement but is not a security fix.

---

### review-security-m-007: navDeviationGuard disabled — CONFIRMED

**Evidence:**
- `contracts/vaults/BasketVault.sol:213`: `uint256 public navDeviationGuardBps;` — no constructor initialization, defaults to 0.
- `contracts/vaults/BasketVault.sol:209`: "`0` DISABLES the guard"

**Verdict:** CONFIRMED. Guard disabled by default.

---

### review-security-m-008: No admin single-asset sell — CONFIRMED

**Evidence:**
- `contracts/vaults/BasketVault.sol:1097-1102`:
  ```solidity
  function removeAsset(uint256 index) external onlyRole(ADMIN_ROLE) {
      if (index >= assets.length || !assets[index].active) revert AssetNotFound();
      if (IERC20(assets[index].token).balanceOf(address(this)) > 0) revert AssetStillHeld();
      assets[index].active = false;
      emit AssetRemoved(index, assets[index].token);
  }
  ```

**Verdict:** CONFIRMED. No admin function to sell a single asset with non-zero balance.

---

### review-security-m-009: vm.skip() in formal verification CI — CONFIRMED

**Evidence:**
- `contracts/test/fv/CustodyMultiVault.t.sol:96-100`:
  ```solidity
  vm.skip(
      true,
      "basket-family custody handler needs vetted-adapter rig - remediation #966 (ADP-2)"
  );
  fail();
  ```
- `contracts/test/fv/CustodyMultiVault.t.sol:107-110`: Same pattern for RwaVault.

**Verdict:** CONFIRMED. Two of three SUP-1 sub-invariants permanently skipped.

---

### review-security-m-010: No BasketVault TWAP fork test — CONFIRMED

**Evidence:**
- `contracts/test/fv/TwapManipulation.t.sol:103`: `twap.quote(units)` — uses mock TWAP object.
- No fork test exercises BasketVault TWAP manipulation against a live pool.

**Verdict:** CONFIRMED. TWAP manipulation path not fork-tested with live pool.

---

### review-security-m-011: Slither fail_on: high only — CONFIRMED

**Evidence:**
- `slither.config.json`: `{"filter_paths": "lib/,contracts/test/,contracts/script/", "fail_on": "high"}`
- Medium-severity findings pass CI silently.

**Verdict:** CONFIRMED. Medium findings pass CI silently.

---

### review-security-m-012: MorphoAdapter totalAssets() theoretical NAV — CONFIRMED

**Claim:** `totalAssets()` returns `MORPHO_VAULT.convertToAssets(shares)` which can overstate NAV during market stress. `isExact()` returns `true` misleading callers.

**Evidence:**
- `contracts/adapters/MorphoAdapter.sol:170-171`:
  ```solidity
  uint256 shares = MORPHO_VAULT.balanceOf(address(this));
  return MORPHO_VAULT.convertToAssets(shares);
  ```
  Returns theoretical NAV = `totalAssets * shares / totalSupply`. If the Morpho vault holds bad debt (defaulted market), `totalAssets` is inflated and `convertToAssets` overstates the true withdrawable value.
- `contracts/adapters/MorphoAdapter.sol:177`:
  ```solidity
  function isExact() external pure returns (bool) { return true; }
  ```
  The vault trusts this adapter's `totalAssets()` value without margin. Router weight calculations use it directly.
- `contracts/adapters/MorphoAdapter.sol:86-91`: The `maxExposure` cap limits total at-risk amount but does not correct NAV — it prevents additional deposits into the adapter but does not discount the existing balance.
- `contracts/adapters/MorphoAdapter.sol:144-145`:
  ```solidity
  uint256 redeemable = MORPHO_VAULT.convertToAssets(shares);
  ```
  The v2 `withdraw()` also uses the same theoretical NAV to determine the redeemable amount. If NAV is overstated, the `withdraw()` would attempt to request more USDC than Morpho can deliver, reverting at the Morpho vault.

**Impact analysis:** Under normal conditions this is accurate — Morpho Gauntlet USDC Prime is designed to maintain 1:1 USDC convertibility. The finding is a forward-looking risk: if a Morpho market defaults, bad debt propagates into the vault's NAV. `isExact()=true` amplifies the impact because the vault applies no NAV discount.

**Verdict:** CONFIRMED. Theoretical NAV is standard for lending adapters but `isExact()=true` means the vault has no defensive margin. Documented upstream-venue risk.

---

## Summary of Changes from Original Review

| Finding | Original Verdict | Verified Verdict | Change |
|---------|-----------------|-------------------|--------|
| review-security-h-001 | High | High (CONFIRMED) | — |
| review-security-h-002 | High | High (CONFIRMED) | — |
| review-security-h-003 | High | High (CONFIRMED) | — |
| review-security-h-004 | High | High (CONFIRMED) | — |
| review-security-h-005 | High | High (CONFIRMED) | — |
| review-security-h-006 | High | High (CONFIRMED) | — |
| review-security-h-007 | High | High (CONFIRMED) | — |
| review-security-m-001 | Medium | Medium (CONFIRMED) | — |
| review-security-m-002 | Medium | Medium (CONFIRMED) | — |
| review-security-m-003 | Medium | Medium (CONFIRMED) | — |
| review-security-m-004 | Medium | Medium (CONFIRMED) | — |
| review-security-m-005 | Medium | Medium (CONFIRMED) | — |
| review-security-m-006 | Medium | **REFUTED** | Downgrade — impact overstated |
| review-security-m-007 | Medium | Medium (CONFIRMED) | — |
| review-security-m-008 | Medium | Medium (CONFIRMED) | — |
| review-security-m-009 | Medium | Medium (CONFIRMED) | — |
| review-security-m-010 | Medium | Medium (CONFIRMED) | — |
| review-security-m-011 | Medium | Medium (CONFIRMED) | — |
| review-security-m-012 | **New (Medium)** | Medium (CONFIRMED) | Added post-review: MorphoAdapter theoretical NAV |

**18 of 19 findings CONFIRMED. 1 REFUTED.**
