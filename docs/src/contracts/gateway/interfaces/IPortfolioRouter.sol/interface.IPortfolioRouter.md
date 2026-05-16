# IPortfolioRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/gateway/interfaces/IPortfolioRouter.sol)

**Title:**
IPortfolioRouter

Minimal interface for PortfolioRouter used by RobotMoneyGateway.

The gateway only needs `depositFor`; the full router surface is in
contracts/PortfolioRouter.sol.


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


