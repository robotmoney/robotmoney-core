# DelegatecallProxyAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/8e58630207799c10307586432e49cdc81ca6ac74/contracts/test/AdapterDelegatecallGuard.t.sol)

A contrived "proxy adapter" whose runtime bytecode contains a
`DELEGATECALL` opcode. Mirrors the EIP-1167 minimal-proxy shape: a
single delegatecall to a stored implementation. The point is purely
that `address(this).code` contains opcode `0xF4`; the adapter is
never actually wired to a vault.


## Constants
### IMPLEMENTATION

```solidity
address public immutable IMPLEMENTATION
```


## Functions
### constructor


```solidity
constructor(address implementation_) ;
```

### fallback

Fallback performs a `delegatecall`. The compiler emits a `0xF4`
opcode in the runtime bytecode of this function.


```solidity
fallback() external payable;
```

