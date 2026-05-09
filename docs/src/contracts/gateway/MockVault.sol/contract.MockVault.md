# MockVault
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/gateway/MockVault.sol)

**Inherits:**
ERC20

**Title:**
MockVault

Minimal `IERC4626`-shaped vault for gateway tests. Mints `rmUSDC`
shares 1:1 against deposited USDC. Just enough surface for the
gateway's `vault.deposit()` call to succeed and for tests to assert
share routing.

Out of scope: yield, fees, withdraw/redeem, fee-on-transfer support,
proxy upgradeability. This contract is a TEST FIXTURE only.


## State Variables
### assetToken
Underlying asset, pinned at construction.


```solidity
IERC20 public immutable assetToken
```


## Functions
### constructor


```solidity
constructor(address asset_) ERC20("Mock Robot Money USDC", "rmUSDC");
```

### decimals

Match the underlying USDC's 6 decimals (mirrors ERC-4626 default).


```solidity
function decimals() public pure override returns (uint8);
```

### asset

ERC-4626 `asset()` accessor.


```solidity
function asset() external view returns (address);
```

### totalAssets

Total assets currently held by the vault.


```solidity
function totalAssets() external view returns (uint256);
```

### deposit

ERC-4626-style deposit. Pulls `assets` USDC from `msg.sender`
via `transferFrom`, mints `shares == assets` to `receiver`.


```solidity
function deposit(uint256 assets, address receiver) external virtual returns (uint256 shares);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`assets`|`uint256`|Amount of USDC (6 decimals) to deposit.|
|`receiver`|`address`|Recipient of the freshly minted `rmUSDC` shares.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`shares`|`uint256`|Amount of `rmUSDC` minted (1:1 with assets).|


## Events
### Deposit
ERC-4626-shaped Deposit event so off-chain indexers / tests
can watch share routing.


```solidity
event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
```

## Errors
### ZeroAmount

```solidity
error ZeroAmount();
```

### ZeroReceiver

```solidity
error ZeroReceiver();
```

