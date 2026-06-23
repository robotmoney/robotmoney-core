# NaiveAgentGateway
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/test/DeployTimelock.t.sol)

**Inherits:**
AccessControl

A deliberately NAIVE gateway: plain AccessControl with AGENT_ROLE whose
admin is left at the default (DEFAULT_ADMIN_ROLE), i.e. WITHOUT the
`_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE)` redirect the real
RobotMoneyGateway constructor performs. Models the pre-fix gateway so the
negative test can prove that a naked DEFAULT_ADMIN_ROLE revoke would
brick AGENT_ROLE (fix-interaction warning, F-01).


## Constants
### AGENT_ROLE

```solidity
bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE")
```


## Functions
### constructor


```solidity
constructor(address root) ;
```

