# DelegatecallProxyAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/41d10069f3131869b5f2aee11bc920913e4ab3a6/contracts/test/AdapterDelegatecallGuard.t.sol)

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

