# LeakyRedeemRouterVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/test/GatewayRouter.t.sol)

**Inherits:**
ERC20

Standalone ERC-4626-shaped vault that leaks one share to the caller
during redeem, simulating a misbehaving vault that does not burn all
shares.  Used to trip the ShareCustodyInvariantViolated check in
_executeRouterWithdraw.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Leaky Router Vault", "LRV");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### asset


```solidity
function asset() external view returns (address);
```

### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

### previewDeposit


```solidity
function previewDeposit(uint256 assets) external pure returns (uint256);
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

### redeem

Burns only `shares - 1` but transfers the full `shares` worth of
assets.  The un-burned share stays with `owner` (the gateway), so
the post-call custody invariant fires.


```solidity
function redeem(uint256 shares, address receiver, address owner)
    external
    returns (uint256 assets);
```

