# RmToken
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/17d3c27bc19dd2e7dd9dd09c12e0fb0b8179d593/contracts/RmToken.sol)

**Title:**
RmToken — ERC-20 governance voting token for Robot Money.
A simple ERC-20 with an initial supply minted to a designated minter at
deploy time. The minter address holds the total supply; no further minting
is possible after deployment. Decimals: 18 (standard).
This token is used in testing/devnet environments to provide voting power
to test participants via the faucet tab. It is NOT designed for mainnet
deployment without further audit.


## Constants
### decimals

```solidity
uint8 public constant decimals = 18
```


## State Variables
### name

```solidity
string public name
```


### symbol

```solidity
string public symbol
```


### totalSupply

```solidity
uint256 public totalSupply
```


### _balances

```solidity
mapping(address => uint256) private _balances
```


### _allowances

```solidity
mapping(address => mapping(address => uint256)) private _allowances
```


## Functions
### constructor


```solidity
constructor(
    string memory name_,
    string memory symbol_,
    address initialHolder,
    uint256 initialSupply
) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`name_`|`string`|       Token name, e.g. "Robot Money Token".|
|`symbol_`|`string`|     Token symbol, e.g. "RM".|
|`initialHolder`|`address`|Address that receives the entire initial supply.|
|`initialSupply`|`uint256`|Total supply in base units (18 decimals).|


### balanceOf


```solidity
function balanceOf(address account) external view returns (uint256);
```

### allowance


```solidity
function allowance(address owner, address spender) external view returns (uint256);
```

### transfer


```solidity
function transfer(address to, uint256 amount) external returns (bool);
```

### approve


```solidity
function approve(address spender, uint256 amount) external returns (bool);
```

### transferFrom


```solidity
function transferFrom(address from, address to, uint256 amount) external returns (bool);
```

### _transfer


```solidity
function _transfer(address from, address to, uint256 amount) internal;
```

## Events
### Transfer

```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
```

### Approval

```solidity
event Approval(address indexed owner, address indexed spender, uint256 value);
```

