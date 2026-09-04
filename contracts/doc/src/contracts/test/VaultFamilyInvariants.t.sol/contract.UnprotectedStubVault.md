# UnprotectedStubVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/2b01a1006295a36fa4f656f7aeda0a98b3de7411/contracts/test/VaultFamilyInvariants.t.sol)

**Inherits:**
AccessControl

Deliberately unprotected mock "vault": bare `AccessControl` with a
self-administered `ADMIN_ROLE`, mirroring the shape every real family
member had before this issue (RobotMoneyVault) or would have if a
future vault type forgot to inherit `AdminFloorAccessControlCounter`.
Exists solely for the negative self-test below.


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


## Functions
### constructor


```solidity
constructor(address admin_) ;
```

