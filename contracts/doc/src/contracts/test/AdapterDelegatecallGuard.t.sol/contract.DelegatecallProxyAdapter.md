# DelegatecallProxyAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/AdapterDelegatecallGuard.t.sol)

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

