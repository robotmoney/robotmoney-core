# IPortfolioRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/965f0332a19461dd11d5d5acce5e2d9fe9b00bd3/contracts/gateway/interfaces/IPortfolioRouter.sol)

**Title:**
IPortfolioRouter

Minimal interface for PortfolioRouter used by RobotMoneyGateway.

The gateway needs `depositFor` and `redeemFor`; the full router
surface is in contracts/PortfolioRouter.sol.


## Functions
### depositFor

Split `amount` USDC across active vaults by the current weight
vector. Shares are minted to `receiver` instead of `msg.sender`.


```solidity
function depositFor(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
    external
    returns (uint256[] memory sharesPerLeg);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`receiver`|`address`|         Address that receives minted vault shares per leg.|
|`amount`|`uint256`|           Total USDC to deposit. Must be pre-approved to this contract.|
|`minSharesPerLeg`|`uint256[]`|  Per-leg slippage floor. Pass empty array to skip.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`sharesPerLeg`|`uint256[]`|    Vault shares minted per leg (parallel to weight list).|


### redeemFor

Redeem vault shares proportionally across all vaults in the
current weight vector. Pulls shares from `shareHolder` via ERC-20
`transferFrom` (shareHolder must approve the router for each vault
share token), calls `vault.redeem` on each leg, and forwards
USDC only to `assetRecipient`.


```solidity
function redeemFor(address shareHolder, address assetRecipient, uint256[] calldata sharesPerLeg)
    external
    returns (uint256[] memory assetsPerLeg);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`shareHolder`|`address`|      Address whose vault shares are redeemed (must have approved the router to spend shares per vault).|
|`assetRecipient`|`address`|   Address that receives the redeemed USDC per leg.|
|`sharesPerLeg`|`uint256[]`|     Vault shares to redeem per leg (parallel to weight list). Length must match the current weight vector.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`assetsPerLeg`|`uint256[]`|    USDC received per leg (parallel to `sharesPerLeg`).|


### getEffectiveWeights

Return the currently active vault list used for deposit/redeem
routing (the voted vector when active, otherwise the default).


```solidity
function getEffectiveWeights()
    external
    view
    returns (address[] memory vaults, uint256[] memory bps);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`vaults`|`address[]`| Ordered vault addresses in the effective weight vector.|
|`bps`|`uint256[]`|    Parallel weight array in basis points.|


