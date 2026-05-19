# MockPrototypeVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/86758bec5fa35d059fcb1a3f4a708912cfd4039d/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
ERC20

Stand-in for a prototype basket vault: USDC-backed ERC-4626 that
self-declares prototype status via `isPrototype() == true`.
Used to exercise the `PortfolioRouter` prototype gate without
pulling the heavyweight BasketVault dependency into the router
unit tests. The shape (asset(), previewDeposit(), deposit(),
isPrototype()) is the same surface the real BasketVault exposes.


## Constants
### assetToken

```solidity
IERC20 public immutable assetToken
```


## State Variables
### prototypeFlag

```solidity
bool public prototypeFlag
```


## Functions
### constructor


```solidity
constructor(address asset_, bool initialPrototype) ERC20("Prototype Vault", "PVS");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### asset


```solidity
function asset() external view returns (address);
```

### previewDeposit


```solidity
function previewDeposit(uint256 assets) external pure returns (uint256);
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
```

### isPrototype

Mirrors `BasketVault.isPrototype()` introspection.


```solidity
function isPrototype() external view returns (bool);
```

### setPrototypeFlag

Test hook so a single fixture can flip between
prototype-declared and not-declared without redeploying.


```solidity
function setPrototypeFlag(bool value) external;
```

