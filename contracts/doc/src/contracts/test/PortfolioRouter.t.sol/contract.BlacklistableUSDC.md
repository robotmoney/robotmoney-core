# BlacklistableUSDC
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
ERC20

USDC mock that supports Circle-style address blacklisting.
Any transferFrom whose `from` address is blacklisted reverts,
simulating FS-RTR-1 (USDC blacklist hit inside _executeLeg).


## State Variables
### isBlacklisted

```solidity
mapping(address => bool) public isBlacklisted
```


## Functions
### constructor


```solidity
constructor() ERC20("USD Coin", "USDC");
```

### decimals


```solidity
function decimals() public pure override returns (uint8);
```

### mint


```solidity
function mint(address to, uint256 amount) external;
```

### blacklist


```solidity
function blacklist(address account) external;
```

### transferFrom


```solidity
function transferFrom(address from, address to, uint256 amount) public override returns (bool);
```

