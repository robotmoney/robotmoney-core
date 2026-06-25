# BasketVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/ff7f6357fae66fafd4ea43a7ad5248daf223b17f/contracts/vaults/BasketVault.sol)

**Inherits:**
ERC4626, AccessControl, Pausable, ReentrancyGuard

**Title:**
BasketVault

Abstract ERC-4626 USDC vault that holds a basket of ERC-20 assets.
Deposits are split equally across active basket assets via Uniswap V3
single-hop swaps. Withdrawals swap each asset back to USDC proportionally.
NAV is denominated in USDC using a Uniswap V3 TWAP (time-weighted
arithmetic-mean tick) over a per-asset, admin-configurable window.
Subclasses set the vault name/symbol, max basket size, and default slippage.


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE

```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### MAX_EXIT_FEE_BPS

```solidity
uint256 public constant MAX_EXIT_FEE_BPS = 100
```


### MAX_SLIPPAGE_BPS

```solidity
uint256 public constant MAX_SLIPPAGE_BPS = 500
```


### MAX_BPS
Basis-points denominator (10 000 = 100%). Sourced from the
shared `BpsMath.BPS_DENOMINATOR` so fee/slippage/weight math
cannot drift.


```solidity
uint256 public constant MAX_BPS = BpsMath.BPS_DENOMINATOR
```


### MIN_TWAP_WINDOW
Minimum permitted TWAP window in seconds. Floors the admin's
configuration so a single ADMIN_ROLE write cannot collapse the
oracle to near-spot pricing.


```solidity
uint32 public constant MIN_TWAP_WINDOW = 600
```


### MAX_TWAP_WINDOW
Maximum permitted TWAP window. Caps observation buffer pressure
and keeps NAV responsive on slow-moving assets.


```solidity
uint32 public constant MAX_TWAP_WINDOW = 86_400
```


### DEFAULT_TWAP_WINDOW
Default TWAP window applied when an asset is added before
ADMIN_ROLE has set an explicit per-asset window.


```solidity
uint32 public constant DEFAULT_TWAP_WINDOW = 1_800
```


### SWAP_ROUTER

```solidity
ISwapRouter public immutable SWAP_ROUTER
```


### _USDC

```solidity
IERC20 internal immutable _USDC
```


### MAX_NAV_DEVIATION_BPS
Hard ceiling for `navDeviationGuardBps`. A threshold above this would
make the guard a no-op (any realistic divergence passes), so the
setter rejects it. `internal` (no public getter) to save bytecode on
the EIP-170-tight vault family — the value is documented here.


```solidity
uint256 internal constant MAX_NAV_DEVIATION_BPS = 2_000
```


### MIN_POOL_CARDINALITY
Minimum observation cardinality required on the Uniswap V3 pool
when registering an asset via addAsset(). A cardinality of 1
(the Uniswap deployment default) means observe() can only return
the single stored slot and always reverts with "OLD" for any
non-zero secondsAgo, which would permanently break totalAssets(),
deposits, and withdrawals for the entire basket.


```solidity
uint16 public constant MIN_POOL_CARDINALITY = 2
```


### MIN_POOL_LIQUIDITY
Minimum in-range Uniswap V3 pool liquidity required when
registering an asset via addAsset(). Pools below this floor
cannot absorb vault-sized trades without exceeding the
configured slippage bound, which would leave depositors unable
to exit synchronously — a blocking router-eligibility gap
(basket-vault-gap-report.md §1). Callers must seed pool depth
before calling addAsset.
The value of 1e6 is a conservative floor that rejects completely
empty or dust-seeded pools while being easy for integration tests
to satisfy with a small seed. Production operators are expected
to seed pools well above this floor before activating assets.


```solidity
uint128 public constant MIN_POOL_LIQUIDITY = 1e6
```


## State Variables
### adminCount
Number of accounts currently holding `ADMIN_ROLE`.


```solidity
uint256 public adminCount
```


### assets

```solidity
AssetInfo[] public assets
```


### tvlCap

```solidity
uint256 public tvlCap
```


### perDepositCap

```solidity
uint256 public perDepositCap
```


### exitFeeBps

```solidity
uint256 public exitFeeBps
```


### feeRecipient

```solidity
address public feeRecipient
```


### maxSlippageBps

```solidity
uint256 public maxSlippageBps
```


### shutdown

```solidity
bool public shutdown
```


### depositsPaused

```solidity
bool public depositsPaused
```


### registry
Linked `VaultRegistry`. Set once by `ADMIN_ROLE` via `setRegistry`.
The registry is the only address permitted to call `retire()` /
`unretire()`, so the unified governance retire action (registry
status flip + vault deposit-halt) always lands atomically (DI-2,
FS-VLT-19).


```solidity
address public registry
```


### emergencyUnwindGuard

```solidity
mapping(address => EmergencyUnwindGuard) public emergencyUnwindGuard
```


### twapWindow
Per-asset TWAP window in seconds. `0` falls back to
`DEFAULT_TWAP_WINDOW` so newly registered assets are
immediately manipulation-resistant; ADMIN_ROLE may raise the
window per asset within `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.


```solidity
mapping(address => uint32) public twapWindow
```


### adapterCodeHashAllowed
Runtime-bytecode hashes ADMIN_ROLE has approved for use as a basket
swap+TWAP adapter. `addAsset` rejects any non-zero adapter whose
codehash is not in this set (ADP-2 / NC-2). The default Uniswap V3
path (`adapter == address(0)`) needs no entry — it routes through the
immutable, audited `SWAP_ROUTER`, not an external adapter.


```solidity
mapping(bytes32 codeHash => bool allowed) public adapterCodeHashAllowed
```


### navDeviationGuardBps
ORA-4 / F-10 — maximum permitted divergence (in bps) between the
NAV-pricing TWAP and the executable market (spot) price before
deposits/redemptions are halted on the deposit/redeem hot path.
A stale or manipulated mark whose spot has moved beyond this band
reverts `NavMarketDeviationExceeded` rather than settling at a
price the market no longer offers. `0` DISABLES the guard (used
by fixtures and any vault that opts out); production deployments
set a non-zero, timelock-governed threshold. Bounded above by
`MAX_NAV_DEVIATION_BPS`.


```solidity
uint256 public navDeviationGuardBps
```


### _lastMintedShares
AZ-BSK-2: scratch slots set by _deposit/_withdraw so that the
overridden deposit()/redeem() can return the ACTUAL minted/withdrawn
amounts instead of OZ's pre-computed preview values. The reentrancy
guard on _deposit/_withdraw ensures these are single-writer.
`internal` (no public getter) to save bytecode on the EIP-170-tight
vault family.


```solidity
uint256 internal _lastMintedShares
```


### _lastWithdrawnAssets

```solidity
uint256 internal _lastWithdrawnAssets
```


## Functions
### _grantRole

Track `ADMIN_ROLE` membership so the last-admin floor can be enforced
without enumeration. Only increments on a real (new) grant.


```solidity
function _grantRole(bytes32 role, address account) internal virtual override returns (bool);
```

### _revokeRole

Block revoking/renouncing the final `ADMIN_ROLE` holder (ACL-3 / F-06);
both public setters route through here. Decrements only on a real
(effective) revoke.


```solidity
function _revokeRole(bytes32 role, address account) internal virtual override returns (bool);
```

### constructor


```solidity
constructor(
    string memory name_,
    string memory symbol_,
    IERC20 usdc_,
    ISwapRouter swapRouter_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    uint256 initialSlippageBps_,
    address feeRecipient_,
    address admin_,
    address emergencyResponder_
) ERC4626(usdc_) ERC20(name_, symbol_);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`name_`|`string`||
|`symbol_`|`string`||
|`usdc_`|`IERC20`||
|`swapRouter_`|`ISwapRouter`||
|`tvlCap_`|`uint256`||
|`perDepositCap_`|`uint256`||
|`exitFeeBps_`|`uint256`||
|`initialSlippageBps_`|`uint256`||
|`feeRecipient_`|`address`||
|`admin_`|`address`|             Receives ADMIN_ROLE (cold/multisig key for parameter changes). Must not be address(0).|
|`emergencyResponder_`|`address`|Receives EMERGENCY_ROLE (hot key for rapid unwind/shutdown). Must not be address(0). May equal admin_ as a conscious choice (e.g. in test environments), but operators SHOULD use distinct addresses in production so a single key compromise cannot both alter parameters and trigger an emergency unwind.|


### maxAssets

Subclasses declare the maximum number of assets in the basket.


```solidity
function maxAssets() public view virtual returns (uint256);
```

### _guardAssets

Reinterpret the `assets` storage array as the layout-identical
`BasketAssetConfigGuard.AssetInfo[]` so the delegatecall-linked dedup
scan can read/write it. The two structs share an exact field layout;
only the nominal type differs, so the storage-pointer cast is sound.


```solidity
function _guardAssets() internal view returns (BasketAssetConfigGuard.AssetInfo[] storage g);
```

### decimals


```solidity
function decimals() public pure override(ERC4626) returns (uint8);
```

### _decimalsOffset


```solidity
function _decimalsOffset() internal pure override returns (uint8);
```

### totalAssets

USDC value of all held assets (idle USDC + TWAP-priced basket assets).

Marked `virtual` so subclasses (e.g. RwaVault) can inject oracle-freshness
checks before delegating to this base implementation.


```solidity
function totalAssets() public view virtual override returns (uint256);
```

### deposit

AZ-BSK-2: override OZ ERC4626.deposit() to return the ACTUAL
minted share count rather than OZ's pre-computed previewDeposit
estimate.
OZ ERC4626.deposit() computes `shares = previewDeposit(assets)`
before calling _deposit() and returns that pre-computed value.
BasketVault._deposit() discards the precomputed shares and mints
post-swap realizedDelta shares instead, so OZ's return value is
overstated when realized NAV > slippage floor. PortfolioRouter
compares minSharesPerLeg against the deposit() return value; an
overstated return makes the per-leg slippage guard ineffective.
This override reads _lastMintedShares written by _deposit() and
returns that instead.


```solidity
function deposit(uint256 assets, address receiver) public override returns (uint256);
```

### _deposit

Deposit `assets` USDC and mint shares on the REALIZED swap
proceeds (post-swap NAV delta), not a pre-swap TWAP mark.

SUP-3 / F-16 / NC-6: the OZ default mints `previewDeposit(assets)`
shares BEFORE the deposit USDC is swapped into basket tokens. When
the realized spot proceeds diverge from the TWAP mark, the minted
share count no longer matches the value the vault actually captured:
if spot beats TWAP the depositor's own swap surplus inflates their
share value so `previewRedeem(previewDeposit(x)) > x` becomes
reachable (a farmable round-trip leak). We override `_deposit` to
swap FIRST, measure the realized TWAP-valued NAV delta the vault
gained, and mint against the FULL realized delta — closing the
AZ-BSK-1 value-extraction vector where the slippage floor was used as
a credit cap instead of a revert guard. The slippage floor now acts
only as a revert guard (AZ-BSK-1 fix). SUP-3 is preserved because
`previewRedeem(previewDeposit(x)) <= x` holds: `previewDeposit`
returns the slippage-discounted floor (a lower bound on actual minted
shares) and `previewRedeem` discounts by slippage again on exit.

Deposit core (the OZ `deposit`/`mint` entrypoints route here). The
`shares` arg OZ pre-computed from `previewDeposit`/`previewMint` is
DISCARDED: we mint on the REALIZED post-swap NAV delta instead, so
the minted count reflects the value the vault actually captured —
not a pre-swap TWAP mark — closing the SUP-3/F-16/NC-6 round-trip
leak. `deposit()` is overridden to return the actual minted share
count (AZ-BSK-2 fix) rather than OZ's pre-computed preview value.


```solidity
function _deposit(
    address caller,
    address receiver,
    uint256 usdcAmount,
    uint256 /*shares*/
)
    internal
    override
    whenNotPaused
    nonReentrant;
```

### _routeDeposit

Splits usdcAmount equally across active assets, swapping each portion via the
per-asset swap adapter (Aerodrome or Uniswap V3 default).
The first active asset absorbs any indivisible remainder.
Emits a WeightSnapshot event recording the equal-weight allocation applied.


```solidity
function _routeDeposit(address caller, uint256 usdcAmount) internal;
```

### redeem

AZ-BSK-2: override OZ ERC4626.redeem() to return the ACTUAL
withdrawn USDC amount rather than OZ's pre-computed previewRedeem
estimate.
OZ ERC4626.redeem() computes `assets = previewRedeem(shares)` before
calling _withdraw() and returns that pre-computed value. BasketVault.
_withdraw() delivers post-swap net USDC (after exit fee), which can
differ from previewRedeem. PortfolioRouter compares minAssetsPerLeg
against the redeem() return value; an overstated return makes the
per-leg slippage guard ineffective.
This override reads _lastWithdrawnAssets written by _withdraw() and
returns that instead.


```solidity
function redeem(uint256 shares, address receiver, address owner)
    public
    override
    returns (uint256);
```

### previewRedeem

Worst-case floor of USDC received when redeeming `shares`.
The floor is: TWAP NAV × (1 − maxSlippageBps) × (1 − exitFeeBps).
This satisfies the ERC-4626 guarantee that `redeem(s, ...)` returns
at least `previewRedeem(s)` because:
1. `totalAssets()` is TWAP-priced (not slot0), so NAV is
manipulation-resistant.
2. `maxSlippageBps` is the worst-case slippage passed as
`amountOutMinimum` to the Uniswap V3 router. Actual swap
proceeds are always ≥ that floor (or the swap reverts).
3. The exit fee is deducted on the same proceeds in `_withdraw`.
Documented as a floor, not an exact quote — actual proceeds will
typically exceed this value when swap depth is healthy.
See docs/technical/basket-vault-gap-report.md §3, §5.
Drawdown redemption policy (ADR-0007): this vault uses a NAV-haircut
model. Depositors always redeem at the current per-share NAV, which
already reflects any drawdown via this slippage-adjusted floor.
Drawdown losses are borne pro-rata by the redeeming depositor; there
is NO forced sale and NO withdrawal queue. The `maxSlippageBps`
floor acts as the bounded-slippage / minimum-haircut cap: a
redemption that cannot clear within that bound reverts rather than
settling at a sandwiched, catastrophic price. ERC-4626 only
guarantees `redeem >= previewRedeem`, not `previewRedeem >= deposit`.
See docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md.


```solidity
function previewRedeem(uint256 shares) public view override returns (uint256);
```

### previewDeposit

Worst-case shares estimate for a deposit of `assets_` USDC.
The floor is computed by discounting the deposited USDC by
`maxSlippageBps` before converting to shares. This reflects that
the Uniswap V3 router guarantees at least
`amountOutMinimum = TWAP × (1 − maxSlippageBps)` tokens will be
acquired per leg. The resulting share count represents the minimum
shares a depositor can expect; actual shares may be higher when
swap depth is healthy.
Documented as a floor, not an exact quote.
See docs/technical/basket-vault-gap-report.md §3.


```solidity
function previewDeposit(uint256 assets_) public view override returns (uint256);
```

### previewMint

Worst-case assets required to mint `shares`.
Grosses up the raw NAV by `MAX_BPS / (MAX_BPS - maxSlippageBps)` so that
after the on-chain swap applies the same `maxSlippageBps` haircut, the vault
captures the full proportional NAV. Without this override, `mint()` would
undercharge relative to `deposit()`, allowing a permissionless value leak
onto existing holders (see docs/code-review/20260609-code-review-internal-claude.md H-1).
Rounded up (Ceil) so the vault is never shortchanged.


```solidity
function previewMint(uint256 shares) public view override returns (uint256);
```

### maxDeposit

Maximum USDC that can be deposited given current vault state.
Returns 0 when the vault is paused or shut down, when no basket
asset is active, or when the TVL cap is reached; otherwise
min(perDepositCap, TVL-cap headroom). Overrides the OZ default
(`type(uint256).max`) for ERC-4626 conformance: max* views MUST
return 0 when deposits are disabled (audit 2026-06-09, L-16).


```solidity
function maxDeposit(address) public view override returns (uint256);
```

### maxMint

Maximum shares that can be minted given current vault state.
Derived from `maxDeposit` through the slippage-discounted share
conversion (`previewDeposit`) so the implied asset charge of
`mint(maxMint(receiver))` stays within the deposit caps
(audit 2026-06-09, L-16).


```solidity
function maxMint(address receiver) public view override returns (uint256);
```

### previewWithdraw

BasketVault cannot guarantee ERC-4626 withdraw exactness because
the actual USDC delivered depends on proportional swap execution
and variable on-chain slippage. Use `redeem()` instead — the ERC-4626
redeem guarantee (actual ≥ previewRedeem) is enforced at the swap level.


```solidity
function previewWithdraw(uint256) public view override returns (uint256);
```

### _withdraw

Performs a proportional-swap withdrawal. The `assets` parameter
is intentionally unused because the actual USDC received depends on
swap execution. Callers MUST NOT use `withdraw()` — use `redeem()` instead.
Actual net may be lower than `previewRedeem` by up to `maxSlippageBps`.

LIFE-3 / NC-3 / F-06: withdrawals are intentionally NOT `whenNotPaused`.
`pause()` is a deposits-only freeze (see `_deposit`, which is
`whenNotPaused` and checks `depositsPaused`). Gating withdrawals on the
same low-trust EMERGENCY_ROLE pause would let a hot key freeze
already-deposited funds — and, combined with last-ADMIN renounce, freeze
them forever (LIFE-4). The last-admin floor (AdminFloorAccessControl)
and the deposits-only pause together keep withdrawals always reachable,
matching RobotMoneyVault's separate `withdrawalsPaused` model.


```solidity
function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256, /* assets — unused; actual determined by swaps */
    uint256 shares
)
    internal
    override
    nonReentrant;
```

### _sellProportional

Sells `shares / supplyBefore` fraction of each active asset and any idle USDC.
Returns total USDC collected (swap proceeds + idle USDC proportion).


```solidity
function _sellProportional(uint256 shares, uint256 supplyBefore)
    internal
    returns (uint256 usdcOut);
```

### _twapUsdcValue

Returns the USDC value of `tokenAmount` tokens, priced via the
adapter's TWAP (or the built-in Uniswap V3 path when adapter is address(0)).


```solidity
function _twapUsdcValue(address pool, address token, address adapter, uint256 tokenAmount)
    internal
    view
    returns (uint256);
```

### _twapTokenValue

Returns the estimated token amount for `usdcAmount` USDC, priced
via the adapter's TWAP (or the built-in Uniswap V3 path when adapter is address(0)).


```solidity
function _twapTokenValue(address pool, address token, address adapter, uint256 usdcAmount)
    internal
    view
    returns (uint256);
```

### effectiveTwapWindow

TWAP-derived window for `token`. Returns the configured
per-asset window or `DEFAULT_TWAP_WINDOW` when unset.

Exposed as a view so off-chain monitors and tests can sanity-check
the effective window without reading the raw mapping fallback.


```solidity
function effectiveTwapWindow(address token) public view returns (uint32);
```

### tickMathLibrary

Address of the externally-linked `TickMath` library this vault
`DELEGATECALL`s on the NAV / `totalAssets()` path.

`TickMath.getSqrtRatioAtTick` is a `public` library function, so the
compiler links it as a separate deployed contract and bakes its
address into this vault's runtime bytecode. Exposing it lets deploy
scripts and tests assert the linked library's runtime codehash equals
the audited artifact (finding L3-D1): a mislinked or zero address —
or one whose code does not match — must fail the deploy assertion.


```solidity
function tickMathLibrary() external pure returns (address lib);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`lib`|`address`|The linked `TickMath` library address.|


### _twapQuote

Compute the time-weighted-average sqrtPriceX96 for `pool` over the
per-asset window and forward to the shared sqrtPriceX96 ratio math.
The non-USDC asset's window governs the read: when quoting
USDC->token (deposit minimums), the token's window is consulted;
when quoting token->USDC (NAV, withdrawal minimums) the same
window applies.


```solidity
function _twapQuote(address pool, address tokenIn, address tokenOut, uint256 amountIn)
    internal
    view
    returns (uint256 amountOut);
```

### setAdapterCodeHashAllowed

Approve or revoke an adapter runtime-bytecode hash for use as a
basket swap+TWAP adapter in `addAsset`. Restricted to ADMIN_ROLE.

ADP-2 / NC-2: `addAsset` rejects any non-zero adapter whose codehash
is not approved here. Revoking a codehash does NOT retroactively touch
assets already registered with that adapter — it only blocks future
`addAsset` calls. Mirrors `RobotMoneyVault.setAdapterCodeHashAllowed`.


```solidity
function setAdapterCodeHashAllowed(bytes32 codeHash_, bool allowed_)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`codeHash_`|`bytes32`|Runtime-bytecode hash (`adapter.codehash`) to approve/revoke.|
|`allowed_`|`bool`| True to approve, false to revoke.|


### addAsset

Register a new basket asset. Restricted to ADMIN_ROLE.

Reverts with InsufficientPoolCardinality when the pool's current
observationCardinality is below MIN_POOL_CARDINALITY. Callers must
invoke pool.increaseObservationCardinalityNext(n) and wait for the
cardinality to be populated before calling addAsset.


```solidity
function addAsset(
    address token_,
    address pool_,
    uint24 swapFee_,
    address adapter_,
    Venue venue_
) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token_`|`address`|   ERC-20 token address.|
|`pool_`|`address`|    DEX pool pairing `token_` with USDC (either token0 or token1). For the Uniswap V3 default path, this is the V3 pool address. For Aerodrome, this is the CL pool address used for TWAP reads.|
|`swapFee_`|`uint24`| Venue parameter forwarded to execution: Uniswap fee tier for V3/V4, or signed tick spacing for Aerodrome Slipstream.|
|`adapter_`|`address`| Swap+TWAP adapter address implementing `IBasketSwapAdapter`. Pass `address(0)` to use the built-in Uniswap V3 default path (venue = V3). For V4 or Aerodrome, pass the deployed adapter address and the corresponding `venue_`.|
|`venue_`|`Venue`|   DEX venue selector. Must match the adapter type: `Venue.V3` with `adapter_=address(0)`, `Venue.V4` with a `UniswapV4SwapAdapter`, `Venue.Aerodrome` with an `AerodromeSwapAdapter`. Stored on `AssetInfo` so governance tooling can inspect the venue without decoding the adapter address.|


### removeAsset

Deactivate a basket asset. The vault must hold zero of that token. Restricted to ADMIN_ROLE.


```solidity
function removeAsset(uint256 index) external onlyRole(ADMIN_ROLE);
```

### reabsorbRemovedAsset

Re-absorb a balance that has reappeared on a removed (inactive)
basket asset by swapping it to USDC into NAV (custody invariant
INV-2). Permissionless: anyone may trigger it, and the proceeds
always land in this vault — there is NO caller-supplied recipient
and no admin-routable path (INV-1).

Replaces the deleted admin `rescueTokens` escape hatch for inactive
basket assets (audit 2026-06-09 L-15). `totalAssets` and
`_sellProportional` skip inactive assets, so a balance that
reappears after `removeAsset` (e.g. a late airdrop, a delayed
transfer, or a residual dust sweep from the underlying venue) would
otherwise be uncounted and unredeemable. Swapping it back to USDC
credits it to ALL holders pro-rata (NAV rises), keeping the
no-stranded-asset invariant without arbitrary admin routing. The
min-out is TWAP-derived and slippage-bounded exactly like the
proportional-withdraw sell leg, so the swap fails closed if the
oracle is unavailable or the price is manipulated. The additional
caller-supplied minUsdcOut is checked against the actual received
amount and reverts with SlippageExceeded if not met (AZ-BSK-5).


```solidity
function reabsorbRemovedAsset(uint256 index, uint256 minUsdcOut) external nonReentrant;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`index`|`uint256`|     Registry index of an inactive (removed) basket asset.|
|`minUsdcOut`|`uint256`|Caller-supplied slippage floor (in USDC raw units). Reverts with SlippageExceeded when the swap output is below this floor, preventing MEV sandwich attacks on NAV recovery. Pass 0 to use only the TWAP-derived floor. Only enforced on the pool-healthy path; the degraded-pool path quarantines instead of swapping.|


### _slippageFloor

TWAP-derived, slippage-bounded USDC floor for selling `amount` of a
basket asset. Shared by the proportional-withdraw sell leg and the
removed-asset re-absorption path.


```solidity
function _slippageFloor(AssetInfo memory assetInfo, uint256 amount)
    internal
    view
    returns (uint256);
```

### _applySlippage

Apply the configured max-slippage haircut to a USDC value.


```solidity
function _applySlippage(uint256 usdcValue) internal view returns (uint256);
```

### setRegistry

Set the linked `VaultRegistry` once. Restricted to `ADMIN_ROLE`.
The registry is the only address permitted to call `retire()` /
`unretire()`; this dedicated link keeps the registry's authority
over the vault narrow (deposit-halt only, not full admin) while
letting the unified governance retire action land atomically.


```solidity
function setRegistry(address newRegistry) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newRegistry`|`address`|Address of the `VaultRegistry` (must not be zero).|


### retire

Hard-stop direct deposits. Callable ONLY by the linked registry,
which sets registry status to `Retired` in the same call (atomic
unified governance retire, DI-2 / FS-VLT-19). Idempotent.
Withdrawals/redemptions stay open (ERC-4626 `redeem` is never
revoked; ADR-0009).


```solidity
function retire() external;
```

### unretire

Re-open direct deposits (governance abort). Callable ONLY by the
linked registry, mirroring the `Retired → Active` transition in
docs/architecture.md §4.7. Idempotent.


```solidity
function unretire() external;
```

### pause


```solidity
function pause() external onlyRole(EMERGENCY_ROLE);
```

### unpause


```solidity
function unpause() external onlyRole(ADMIN_ROLE);
```

### _setDepositsPaused


```solidity
function _setDepositsPaused(bool paused_) internal;
```

### emergencyUnwind

Pause deposits and swap all basket assets back to USDC.

The effective per-leg floor is max(TWAP-derived, configured minUsdcOut), so the
admin-set value acts as a secondary lower bound while the live TWAP guards against
stale configuration being exploited by a sandwich attacker. If the
oracle is unavailable, a non-zero configured floor is required.
Reverts when any router leg cannot satisfy its effective floor.


```solidity
function emergencyUnwind() public virtual onlyRole(EMERGENCY_ROLE) nonReentrant;
```

### emergencyTwapUsdcValue


```solidity
function emergencyTwapUsdcValue(AssetInfo calldata assetInfo, uint256 amount)
    external
    view
    returns (uint256);
```

### emergencyUnwindWithOverride

Explicit high-risk emergency unwind for tokens whose guard permits overrides.

Emits before each swap so off-chain operators can distinguish override use.
Even on the override path, swap outputs are bounded by an upper-loss
cap derived from the admin-configured `minUsdcOut` reference floor:
`appliedFloor = minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`.
The override is deliberately oracle-independent so a broken oracle
cannot block incident response. The configured loss cap remains mandatory.


```solidity
function emergencyUnwindWithOverride(address[] calldata tokens)
    public
    virtual
    onlyRole(EMERGENCY_ROLE)
    nonReentrant;
```

### shutdownVault


```solidity
function shutdownVault() external onlyRole(EMERGENCY_ROLE);
```

### restoreVault

Reverse a `shutdownVault`, re-opening deposits with a fresh TVL cap.

LIFE-4 / F-07: `shutdownVault` (an `EMERGENCY_ROLE` hot-key lever) sets
`shutdown = true` and `tvlCap = 0`, which permanently blocks deposits with no
reverse path — a low-trust key could otherwise freeze the deposit side forever.
Withdrawals are never frozen (LIFE-3), so holder funds were always redeemable;
this restores the DEPOSIT side and is therefore gated to the strictly higher-trust
`ADMIN_ROLE` (timelock in production), mirroring `unpause`. A new `tvlCap` is
required because shutdown zeroed it; pass `type(uint256).max` for no cap.
Mirrors `RobotMoneyVault.restoreVault`: reverts when the vault is not shut down
(`NotShutdown`), when the new cap is zero (`InvalidParam`), or when the new cap
is below the configured `perDepositCap` (`InvalidParam`), so deposits resume under
a coherent, explicit limit rather than a stale or self-contradictory one.


```solidity
function restoreVault(uint256 newTvlCap) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newTvlCap`|`uint256`|New maximum total assets in 6-decimal USDC units (must be > 0).|


### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token held by the
vault to the fixed quarantine address (custody invariants
INV-1/INV-2).
Anyone may call; the destination is a hardcoded constant, never
caller-supplied. This replaces the deleted arbitrary-recipient
`rescueTokens(token,to)` admin function (INV-1). Reverts when
`token` is USDC, the vault share token, or ANY basket asset —
active OR configured-but-inactive. Inactive (removed) basket
assets are NOT swept here: a balance that reappears on a removed
asset is re-absorbed into NAV via `reabsorbRemovedAsset` (INV-2),
never routed to an admin or to quarantine, so it stays redeemable
by holders (this is the no-stranded-asset replacement for the
audit 2026-06-09 L-15 admin rescue path).


```solidity
function sweepForeignToken(address token) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to quarantine. Must not be USDC, the share token, or any active/configured basket asset.|


### _sweepToQuarantine

Single inlining site for the permissionless quarantine sweep so the
`ForeignTokenQuarantine.sweep` body is emitted into the
EIP-170-tight basket-vault bytecode only once, shared by
`sweepForeignToken` and the `reabsorbRemovedAsset` degraded-pool
fallback. Moves the caller's full balance of `token` to the fixed
quarantine address; no caller-supplied recipient (INV-1).


```solidity
function _sweepToQuarantine(address token) private;
```

### setTvlCap


```solidity
function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### setPerDepositCap


```solidity
function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE);
```

### setExitFeeBps


```solidity
function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### setFeeRecipient


```solidity
function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE);
```

### setNavDeviationGuardBps

Set the NAV-vs-market deviation guard threshold (ORA-4 / F-10).

ADMIN_ROLE only (timelock in production). `0` disables the guard;
any non-zero value must be `<= MAX_NAV_DEVIATION_BPS`. When set,
deposits revert `NavMarketDeviationExceeded` if any active asset's
executable market (spot) price diverges from its NAV-pricing TWAP
beyond `newBps`. Independent of `maxSlippageBps` (the swap floor),
which stays TWAP/pool-fee-derived (ORA-7) — the two bounds never
share a source.


```solidity
function setNavDeviationGuardBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newBps`|`uint256`|New deviation threshold in basis points.|


### setMaxSlippageBps

Update the worst-case slippage bound used for swap floors and previews.

Bounded above by `MAX_SLIPPAGE_BPS` and below by `minSlippageFloorBps()`
(the highest active asset's pool fee tier in bps) so a single admin write
cannot set an unsatisfiable `amountOutMinimum` and brick all swaps
(audit 2026-06-09, L-17).


```solidity
function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE);
```

### minSlippageFloorBps

Lower bound accepted by `setMaxSlippageBps`: the highest pool fee
tier among active basket assets, expressed in basis points
(`swapFee` is in hundredths of a bip, e.g. 3000 → 30 bps).
Returns 0 when no asset is active (nothing can brick).


```solidity
function minSlippageFloorBps() public view returns (uint256 floorBps);
```

### setEmergencyUnwindGuard

Configure per-token minimum USDC output, optional high-risk override
access, and the upper-loss cap that bounds override-path slippage.


```solidity
function setEmergencyUnwindGuard(
    address token,
    uint256 minUsdcOut,
    bool overrideAllowed,
    uint256 maxLossBps
) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|           Active basket asset to configure.|
|`minUsdcOut`|`uint256`|      Admin-set reference floor used as the upper-loss reference on the override path and as the hard minimum on the non-override path.|
|`overrideAllowed`|`bool`| Whether the override path may be invoked at all.|
|`maxLossBps`|`uint256`|      Maximum acceptable loss in basis points versus `minUsdcOut` when the override path executes a swap. Must be <= MAX_BPS. A value of `MAX_BPS` (10_000) reproduces the legacy zero-floor behaviour. ADMIN_ROLE is timelock-gated via the existing ADMIN_ROLE pattern (see `docs/technical/security-model.md`).|


### setTwapWindow

Set the TWAP window in seconds for `token`. ADMIN_ROLE only.

The window must fall inside `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.
ADMIN_ROLE is expected to verify off-chain that the pool's
observation cardinality is large enough to satisfy the requested
window; otherwise NAV / unwind reads will revert with the pool's
`"OLD"` error.


```solidity
function setTwapWindow(address token, uint32 window) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|  Active basket asset to configure.|
|`window`|`uint32`| TWAP window in seconds (10 min ≤ window ≤ 24 h).|


### rebalance

Reserved for Phase B: global vault rebalance.

Not implemented in MVP. Reverts with `NotImplemented()`.
Eventual signature (subject to Phase B ADR):
rebalance(uint256 maxSlippageBps, uint256 deadline)
-> (uint256[] swapAmounts, uint256[] gasEstimates)
See docs/adr/ADR-0003-basketvault-rebalancing-model.md


```solidity
function rebalance(uint256, uint256) external pure;
```

### previewDepositWeights

Pre-execution cost preview: shows how `usdcAmount` would be allocated
across active basket assets at current TWAP prices.
Returns parallel arrays of `(assets, amountsOut)` for active assets only.
This satisfies the cost-preview requirement in docs/architecture.md §7.1 — Previews.
See docs/adr/ADR-0003-basketvault-rebalancing-model.md.


```solidity
function previewDepositWeights(uint256 usdcAmount)
    external
    view
    returns (address[] memory activeAssets, uint256[] memory amountsOut);
```

### realizedWeights

Per-depositor realized weight vector.
Returns each active asset's share of the depositor's pro-rata vault
holdings, expressed in basis points (0–10_000), where 10_000 = 100%.
A depositor with no shares gets all-zero weights.
See docs/adr/ADR-0003-basketvault-rebalancing-model.md.


```solidity
function realizedWeights(address depositor)
    external
    view
    returns (address[] memory activeAssets, uint256[] memory bpsWeights);
```

### assetUsdcValue

USDC value of `amount` of the active asset at registry `index`,
priced via its TWAP adapter (or the built-in V3 path). Used by the
externally-linked `BasketViews` weight-preview library.


```solidity
function assetUsdcValue(uint256 index, uint256 amount) external view returns (uint256);
```

### assetTokenValue

Estimated token amount for `usdcAmount` of the active asset at
registry `index`. Used by the `BasketViews` weight-preview library.


```solidity
function assetTokenValue(uint256 index, uint256 usdcAmount) external view returns (uint256);
```

### assetCount


```solidity
function assetCount() external view returns (uint256);
```

### activeAssetCount


```solidity
function activeAssetCount() external view returns (uint256);
```

### isShutdown


```solidity
function isShutdown() external view returns (bool);
```

### _activeAssetCount


```solidity
function _activeAssetCount() internal view returns (uint256 count);
```

### _activeAssetForToken


```solidity
function _activeAssetForToken(address token) internal view returns (AssetInfo memory);
```

### _emergencyUnwindAsset


```solidity
function _emergencyUnwindAsset(AssetInfo memory assetInfo, uint256 minUsdcOut) internal;
```

### _emergencyUnwindAssetWithCap

Override-path swap helper. Passes `appliedFloor` as the router-level
`amountOutMinimum` and additionally enforces the cap with a typed
`EmergencyUnwindLossCapExceeded` revert so off-chain consumers see
a stable error surface regardless of the underlying router's
slippage revert format.


```solidity
function _emergencyUnwindAssetWithCap(AssetInfo memory assetInfo, uint256 appliedFloor)
    internal;
```

### _executeSwap

Routes a swap through the per-asset adapter when set, or falls back
to the immutable Uniswap V3 SWAP_ROUTER.  Centralises approval
management: forceApprove before the call, clear after.
Deadline note (audit 2026-06-09, L-5): adapters take an explicit
caller-chosen `deadline` instead of hardcoding `block.timestamp`.
This vault's entry points are standard ERC-4626 (no deadline
parameter), and every swap executes synchronously inside the
caller's transaction, so the vault pins the deadline to the current
block — equivalent protection to a tx-level deadline. External
integrators calling adapters directly MUST supply a real deadline.


```solidity
function _executeSwap(
    address adapter,
    address tokenIn,
    address tokenOut,
    uint24 fee,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient
) internal returns (uint256 amountOut);
```

## Events
### RegistrySet
Emitted when `ADMIN_ROLE` sets the linked registry for the first time.


```solidity
event RegistrySet(address indexed oldRegistry, address indexed newRegistry);
```

### Retired
Emitted when the registry calls `retire()` and halts direct deposits.


```solidity
event Retired();
```

### Unretired
Emitted when the registry calls `unretire()` and re-opens direct deposits.


```solidity
event Unretired();
```

### AssetAdded

```solidity
event AssetAdded(
    uint256 indexed index,
    address indexed token,
    address pool,
    uint24 swapFee,
    address adapter,
    Venue venue
);
```

### AssetRemoved

```solidity
event AssetRemoved(uint256 indexed index, address indexed token);
```

### Swapped

```solidity
event Swapped(
    address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
);
```

### ExitFeeCharged

```solidity
event ExitFeeCharged(
    address indexed owner, address indexed receiver, uint256 gross, uint256 fee, uint256 net
);
```

### TvlCapUpdated

```solidity
event TvlCapUpdated(uint256 oldCap, uint256 newCap);
```

### PerDepositCapUpdated

```solidity
event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
```

### ExitFeeUpdated

```solidity
event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
```

### FeeRecipientUpdated

```solidity
event FeeRecipientUpdated(address oldRecipient, address newRecipient);
```

### MaxSlippageUpdated

```solidity
event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
```

### DepositsPausedSet

```solidity
event DepositsPausedSet(bool paused);
```

### Shutdown

```solidity
event Shutdown();
```

### Restored
Emitted when ADMIN_ROLE reverses a `shutdownVault`, re-opening deposits.


```solidity
event Restored(uint256 newTvlCap);
```

### EmergencyUnwindGuardSet

```solidity
event EmergencyUnwindGuardSet(
    address indexed token,
    uint256 oldMinUsdcOut,
    uint256 newMinUsdcOut,
    bool overrideAllowed,
    uint256 maxLossBps
);
```

### EmergencyUnwindOverrideUsed
Emitted whenever the override path is exercised. `appliedFloor` is the
`amountOutMinimum` actually passed to the router after the upper-loss
cap was applied, so off-chain operators can audit how much loss
versus `minUsdcOut` the EMERGENCY_ROLE accepted on this swap.


```solidity
event EmergencyUnwindOverrideUsed(
    address indexed token,
    uint256 amountIn,
    uint256 minUsdcOut,
    uint256 appliedFloor,
    address indexed caller
);
```

### TwapWindowUpdated
Emitted when ADMIN_ROLE updates the TWAP window for an asset.
Off-chain monitors can use the delta between `oldWindow` and
`newWindow` to detect governance shortening the oracle window.


```solidity
event TwapWindowUpdated(address indexed token, uint32 oldWindow, uint32 newWindow);
```

### AdapterCodeHashAllowedSet
Emitted when ADMIN_ROLE approves or revokes an adapter runtime-code
hash for use in `addAsset` (ADP-2 / NC-2).


```solidity
event AdapterCodeHashAllowedSet(bytes32 indexed codeHash, bool allowed);
```

### NavDeviationGuardUpdated
Emitted when ADMIN_ROLE (timelock) updates the NAV-vs-market
deviation guard threshold (ORA-4 / F-10).


```solidity
event NavDeviationGuardUpdated(uint256 oldBps, uint256 newBps);
```

### WeightSnapshot
Emitted on every deposit, recording the equal-weight allocation applied
to the depositor's inflow. Satisfies the event-stream cost-disclosure
requirement from docs/architecture.md §7.1 — Previews and ADR-0003.
`bpsWeights` contains the basis-point weight for each element of `assets`
(10_000 / n for each active asset, with the remainder allocated to the first).


```solidity
event WeightSnapshot(
    address indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp
);
```

## Errors
### LastAdminFloor
Revoking the sole `ADMIN_ROLE` holder is forbidden (would leave the
vault with zero admins and brick every admin path).


```solidity
error LastAdminFloor();
```

### TVLCapExceeded

```solidity
error TVLCapExceeded();
```

### PerDepositCapExceeded

```solidity
error PerDepositCapExceeded();
```

### ZeroAddress

```solidity
error ZeroAddress();
```

### OnlyRegistry
`retire()` / `unretire()` caller is not the linked registry.


```solidity
error OnlyRegistry();
```

### RegistryAlreadySet
`setRegistry` was called more than once; registry is set-once.


```solidity
error RegistryAlreadySet();
```

### VaultShutdown

```solidity
error VaultShutdown();
```

### NotShutdown
`restoreVault` called while the vault is not in a shut-down state.


```solidity
error NotShutdown();
```

### InvalidFee

```solidity
error InvalidFee();
```

### InvalidParam

```solidity
error InvalidParam();
```

### MaxAssetsReached

```solidity
error MaxAssetsReached();
```

### AssetNotFound

```solidity
error AssetNotFound();
```

### AssetStillHeld

```solidity
error AssetStillHeld();
```

### NoActiveAssets

```solidity
error NoActiveAssets();
```

### NavMarketDeviationExceeded
ORA-4 / F-10: the executable market (spot) price for a basket asset
has diverged from the NAV-pricing TWAP beyond `navDeviationGuardBps`.
Deposits/redemptions revert rather than settle on a stale/manipulated
mark. `deviationBps` is the observed divergence; `thresholdBps` is the
configured guard.


```solidity
error NavMarketDeviationExceeded(address token, uint256 deviationBps, uint256 thresholdBps);
```

### EmergencyUnwindOverrideDisabled

```solidity
error EmergencyUnwindOverrideDisabled();
```

### EmergencyFloorUnavailable

```solidity
error EmergencyFloorUnavailable(address token);
```

### PoolTokenMismatch

```solidity
error PoolTokenMismatch();
```

### AssetInBasket

```solidity
error AssetInBasket();
```

### EmergencyUnwindLossCapExceeded
Raised when a router swap on the override path returns less USDC than
the upper-loss cap permits. The cap is configured per-token via
`setEmergencyUnwindGuard` and bounds the realized loss versus the
admin-set reference floor `minUsdcOut`.


```solidity
error EmergencyUnwindLossCapExceeded(address token, uint256 received, uint256 appliedFloor);
```

### SlippageBelowPoolFeeFloor
Raised when `setMaxSlippageBps` is called with a value below the
pool-fee floor of the active basket. A slippage bound below the fee
tier makes every swap's `amountOutMinimum` unsatisfiable (the fee
alone consumes more than the allowance), bricking deposits and
withdrawals (audit 2026-06-09, L-17).


```solidity
error SlippageBelowPoolFeeFloor(uint256 requestedBps, uint256 floorBps);
```

### InvalidTwapWindow
Raised when ADMIN_ROLE attempts to set a TWAP window outside the
`[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]` range. Surfaces a typed error
rather than a generic `InvalidParam` so off-chain governance
tooling can pin-point the failure mode.


```solidity
error InvalidTwapWindow(uint32 window);
```

### NotImplemented
Raised by the `rebalance()` stub. Global vault rebalancing is not
implemented in the MVP. The selector is reserved for Phase B.
See docs/adr/ADR-0003-basketvault-rebalancing-model.md.


```solidity
error NotImplemented();
```

### InsufficientPoolCardinality
Raised by addAsset() when the pool's observation cardinality is
below the minimum required to service TWAP reads over
`DEFAULT_TWAP_WINDOW`. Cardinality=1 (the Uniswap default) means
`observe()` reverts with "OLD" for any non-zero secondsAgo, which
permanently breaks totalAssets(), deposits, and withdrawals for
every asset in the basket. Call
`pool.increaseObservationCardinalityNext(required)` before adding
the asset, then wait until the pool has accumulated enough
observations to cover the full window before depositing.


```solidity
error InsufficientPoolCardinality(address pool, uint16 required, uint16 actual);
```

### InsufficientObservationHistory

```solidity
error InsufficientObservationHistory(address pool, uint32 requiredWindow);
```

### InsufficientPoolLiquidity
Raised by addAsset() when the pool's in-range liquidity (as
returned by `IUniswapV3Pool.liquidity()`) is below
`MIN_POOL_LIQUIDITY`. Thin pools cannot guarantee synchronous
withdrawal at the TWAP-derived slippage bound — a core router-
eligibility requirement (gap-report §1). Provide depth before
registering the asset.


```solidity
error InsufficientPoolLiquidity(address pool, uint128 required, uint128 actual);
```

### RedeemOnly
Raised by withdraw() and previewWithdraw(). BasketVault cannot
guarantee ERC-4626 exactness for proportional-swap exits — use
redeem() instead, which returns actual swap proceeds.


```solidity
error RedeemOnly();
```

### DepositBelowSlippageFloor
AZ-BSK-1: raised (belt-and-suspenders) when the realized NAV delta
from the deposit swaps falls below the slippage-discounted floor.
Under normal operation the swap router's `amountOutMinimum` guard
fires first; this catches any residual path where total delta is
nevertheless deficient.


```solidity
error DepositBelowSlippageFloor(uint256 realizedDelta, uint256 floor);
```

### SlippageExceeded
AZ-BSK-5: raised when the caller-supplied `minUsdcOut` floor on
`reabsorbRemovedAsset` is not met by the swap output.


```solidity
error SlippageExceeded();
```

## Structs
### AssetInfo

```solidity
struct AssetInfo {
    address token;
    address pool; // DEX pool pairing token with USDC (venue-specific)
    uint24 swapFee; // Fee parameter forwarded to the adapter (e.g. Uniswap V3 fee tier)
    bool active;
    /// @dev Swap + TWAP adapter for this asset. address(0) falls back to the
    ///      default Uniswap V3 path via SWAP_ROUTER, preserving backward compat.
    address adapter;
    /// @notice DEX venue this asset is wired to.
    ///         Mirrors the adapter choice in a human-readable form so governance
    ///         and monitoring tooling can inspect the venue without decoding the
    ///         adapter address.
    Venue venue;
}
```

### EmergencyUnwindGuard

```solidity
struct EmergencyUnwindGuard {
    uint256 minUsdcOut;
    bool overrideAllowed;
    // Maximum acceptable loss (in basis points) versus `minUsdcOut` when the
    // override path is used. The override floor is computed as
    // `minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`. A `maxLossBps` of
    // `MAX_BPS` reproduces the legacy zero-floor behaviour; a value of `0`
    // forbids any loss versus the reference floor.
    uint256 maxLossBps;
}
```

## Enums
### Venue
DEX venue selector for a basket asset.
Recorded on AssetInfo so off-chain tooling and governance can
inspect which DEX each asset is wired to without parsing the
opaque adapter address.
V3       — Uniswap V3 via the built-in SWAP_ROUTER (adapter = address(0)).
V4       — Uniswap V4 via a UniswapV4SwapAdapter.
Aerodrome — Aerodrome CL pool via an AerodromeSwapAdapter.


```solidity
enum Venue {
    V3,
    V4,
    Aerodrome
}
```

