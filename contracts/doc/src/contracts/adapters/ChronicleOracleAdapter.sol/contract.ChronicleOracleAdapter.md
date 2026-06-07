# ChronicleOracleAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/fd1e1fc4dc2a5a456dd5a95f2ef21cdd86bf1dfa/contracts/adapters/ChronicleOracleAdapter.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

**Title:**
ChronicleOracleAdapter

BasketVault swap adapter that routes trades through Aerodrome Finance
and prices NAV via a Chronicle on-chain push oracle.
**Why Chronicle instead of TWAP?**
deSPXA is a thinly-traded RWA token — Aerodrome DEX liquidity is
insufficient to derive a manipulation-resistant TWAP. Chronicle's
attestor network pushes signed NAV prices directly on-chain, providing
an issuer-sanctioned price reference independent of DEX spot conditions.
See ADR-0006 §2 for the full rationale.
**Staleness enforcement** is handled by RwaVault (via the `heartbeat`
parameter at vault construction) rather than in this adapter.
This keeps the adapter stateless and reusable across any vault that
wants Chronicle pricing with Aerodrome routing.
**Freeze-control risk:** If the deSPXA issuer freezes token transfers,
all Aerodrome swaps through this adapter will revert. This is an
inherent property of the RWA asset and is disclosed in ADR-0006 §4.
**Price scaling:**
Chronicle returns prices in 18-decimal WAD format (1e18 = 1 USD).
USDC uses 6 decimals. deSPXA uses 18 decimals (standard ERC-20).
All arithmetic is normalised to 18-decimal precision before scaling
down to the output token's decimals.


## Constants
### WAD
1e18 — Chronicle oracle price scale. Chronicle reports NAV in
units of USDC per deSPXA, scaled to 18 decimal places (WAD).


```solidity
uint256 private constant WAD = 1e18
```


### ROUTER
Aerodrome Router used for all swaps.


```solidity
IAerodromeRouter public immutable ROUTER
```


### FACTORY
Pool factory embedded in Aerodrome Route structs.


```solidity
address public immutable FACTORY
```


### STABLE
Whether the Aerodrome route uses the stable-swap curve.


```solidity
bool public immutable STABLE
```


### ORACLE
Chronicle NAV oracle for the RWA asset (deSPXA on Base).

Must be whitelisted ("kissed") for this adapter's address before
`twapPrice()` can be called. See IChronicleOracle for details.


```solidity
IChronicleOracle public immutable ORACLE
```


### RWA_TOKEN
RWA asset token address (deSPXA). Used to determine price
direction: USDC→deSPXA or deSPXA→USDC.


```solidity
address public immutable RWA_TOKEN
```


### USDC
USDC token address. Used for price direction calculation.


```solidity
address public immutable USDC
```


## Functions
### constructor


```solidity
constructor(
    address router_,
    address factory_,
    bool stable_,
    address oracle_,
    address rwaToken_,
    address usdc_
) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`router_`|`address`|  Aerodrome Router address.|
|`factory_`|`address`| Pool factory address embedded in Aerodrome Route structs.|
|`stable_`|`bool`|  Whether the Aerodrome route uses the stable-swap curve.|
|`oracle_`|`address`|  Chronicle NAV feed for `rwaToken_`.|
|`rwaToken_`|`address`|RWA asset token (deSPXA).|
|`usdc_`|`address`|    USDC token address.|


### swap

Execute a single-hop swap.

Routes via Aerodrome. The `fee` parameter is ignored (Aerodrome
derives fee from pool config). The swap reverts if the deSPXA
issuer has frozen transfers — see ADR-0006 §4 (freeze-control risk).


```solidity
function swap(
    address tokenIn,
    address tokenOut,
    uint24, /* fee — unused by Aerodrome */
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient
) external returns (uint256 amountOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`tokenIn`|`address`|      Address of the token to sell.|
|`tokenOut`|`address`|     Address of the token to buy.|
|`<none>`|`uint24`||
|`amountIn`|`uint256`|     Exact amount of `tokenIn` to sell.|
|`minAmountOut`|`uint256`| Minimum amount of `tokenOut` required; reverts if not met.|
|`recipient`|`address`|    Recipient of `tokenOut`.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`amountOut`|`uint256`|   Actual amount of `tokenOut` received.|


### twapPrice

Compute a TWAP-based price quote: how many `quoteToken` for `baseAmount`
of `baseToken`, reading the oracle from `pool` over `window` seconds.

Uses the Chronicle NAV oracle instead of a DEX TWAP.
The `pool` and `window` parameters are unused — Chronicle provides
a single signed price that is authoritative regardless of DEX state
or lookback window. Both parameters are kept for interface uniformity.
Price direction:
- (baseToken=RWA, quoteToken=USDC): RWA → USDC
quoteAmount = baseAmount * navPrice / WAD * usdcScale / rwaScale
- (baseToken=USDC, quoteToken=RWA): USDC → RWA
quoteAmount = baseAmount * WAD / navPrice * rwaScale / usdcScale
Decimal scaling:
navPrice is in WAD (18 dec). deSPXA is 18 dec. USDC is 6 dec.
navPrice units: USDC per deSPXA, both expressed in WAD.
e.g. if 1 deSPXA = 5.00 USDC: navPrice = 5e18.
Staleness check: NOT enforced here — RwaVault calls
`_checkOracleFreshness()` on every price-sensitive operation before
delegating to this adapter.


```solidity
function twapPrice(
    address, /* pool — unused; Chronicle is pool-independent */
    address baseToken,
    address quoteToken,
    uint256 baseAmount,
    uint32 /* window — unused; Chronicle is epoch-independent */
)
    external
    view
    returns (uint256 quoteAmount);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`<none>`|`address`||
|`baseToken`|`address`|  Token whose amount is the input to the quote.|
|`quoteToken`|`address`| Token whose amount is the output of the quote.|
|`baseAmount`|`uint256`| Amount of `baseToken` to price.|
|`<none>`|`uint32`||

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`quoteAmount`|`uint256`|Estimated amount of `quoteToken` for `baseAmount` of `baseToken`.|


## Errors
### ZeroAddress
Raised when any required address argument is address(0).


```solidity
error ZeroAddress();
```

### UnknownPricePair
Raised when the price direction cannot be determined —
neither (baseToken=RWA, quoteToken=USDC) nor
(baseToken=USDC, quoteToken=RWA) matches the expected pair.


```solidity
error UnknownPricePair(address baseToken, address quoteToken);
```

