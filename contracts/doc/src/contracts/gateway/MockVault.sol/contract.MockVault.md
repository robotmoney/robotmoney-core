# MockVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/09526bad1d1fc83318c95c5e3ae875b62d6bb960/contracts/gateway/MockVault.sol)

**Inherits:**
ERC20

**Title:**
MockVault

Minimal `IERC4626`-shaped vault for gateway tests. Mints `rmUSDC`
shares 1:1 against deposited USDC and redeems 1:1 with no exit fee.
Covers the full deposit→redeem round-trip exercised by the dapp e2e
(issue #257). This contract is a TEST FIXTURE only.


## Constants
### assetToken
Underlying asset, pinned at construction.


```solidity
IERC20 public immutable assetToken
```


### exitFeeBps
No exit fee — mock fixture only.


```solidity
uint256 public constant exitFeeBps = 0
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


### redeem

ERC-4626-style redeem. Burns `shares` from `owner` and
transfers `assets == shares` USDC (1:1, no exit fee) to `receiver`.


```solidity
function redeem(uint256 shares, address receiver, address owner)
    external
    virtual
    returns (uint256 assets);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`shares`|`uint256`|  Amount of `rmUSDC` shares to burn.|
|`receiver`|`address`|Recipient of the redeemed USDC.|
|`owner`|`address`|   Share owner whose balance is debited.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`assets`|`uint256`|  Amount of USDC transferred (== shares, 1:1).|


### maxRedeem

Maximum shares redeemable for `owner` (their full balance).


```solidity
function maxRedeem(address owner) external view returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`owner`|`address`|Address to query.|


### previewRedeem

Preview assets returned for redeeming `shares` (1:1, no exit fee).


```solidity
function previewRedeem(uint256 shares) external pure returns (uint256);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`shares`|`uint256`|Amount of `rmUSDC` shares to preview.|


## Events
### Deposit
ERC-4626-shaped Deposit event.


```solidity
event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`sender`|`address`|  Address that called `deposit` and supplied the assets.|
|`receiver`|`address`|Address that received the minted shares.|
|`assets`|`uint256`|  Amount of underlying USDC deposited.|
|`shares`|`uint256`|  Amount of `rmUSDC` shares minted (1:1 with assets).|

### Withdraw
ERC-4626-shaped Withdraw event.


```solidity
event Withdraw(
    address indexed sender,
    address indexed receiver,
    address indexed owner,
    uint256 assets,
    uint256 shares
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`sender`|`address`|  Address that called `redeem`.|
|`receiver`|`address`|Address that received the USDC.|
|`owner`|`address`|   Address whose shares were burned.|
|`assets`|`uint256`|  Amount of USDC transferred to receiver.|
|`shares`|`uint256`|  Amount of `rmUSDC` shares burned.|

## Errors
### ZeroAmount
Deposit amount is zero.


```solidity
error ZeroAmount();
```

### ZeroReceiver
Share receiver is the zero address.


```solidity
error ZeroReceiver();
```

### InsufficientShares
Owner has fewer shares than the requested redeem amount.


```solidity
error InsufficientShares();
```

