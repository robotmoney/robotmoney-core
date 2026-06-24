# BlacklistableUSDC
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a2a6d8e4e2a61d93030482a63145fd865f67cc02/contracts/test/PortfolioRouter.t.sol)

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

