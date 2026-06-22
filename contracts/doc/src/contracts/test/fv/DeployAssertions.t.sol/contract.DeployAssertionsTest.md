# DeployAssertionsTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9980411a0c386dea831d9088f37c8a87ba5f15b8/contracts/test/fv/DeployAssertions.t.sol)

**Inherits:**
Test


## Constants
### ADMIN_ROLE

```solidity
bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### EMERGENCY_ROLE

```solidity
bytes32 internal constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### PAUSER_ROLE

```solidity
bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE")
```


### AGENT_ROLE

```solidity
bytes32 internal constant AGENT_ROLE = keccak256("AGENT_ROLE")
```


### DEFAULT_ADMIN_ROLE

```solidity
bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00
```


## State Variables
### _aclVault

```solidity
RobotMoneyVault internal _aclVault
```


### _aclGateway

```solidity
RobotMoneyGateway internal _aclGateway
```


### _aclRegistry

```solidity
VaultRegistry internal _aclRegistry
```


### _aclRouter

```solidity
PortfolioRouter internal _aclRouter
```


### _aclGovernance

```solidity
RouterGovernance internal _aclGovernance
```


### _aclDeployer

```solidity
address internal _aclDeployer
```


### _aclEmergency

```solidity
address internal _aclEmergency
```


## Functions
### _contains

Naive substring scan (same pattern as CustodyInvariantGuard.t.sol).


```solidity
function _contains(string memory haystack, string memory needle) internal pure returns (bool);
```

### test_ACL1_eoaHoldsNoPrivilegedRoleAfterHandover

ACL-1 (REMEDIATED by #965, F-01): after the DeployTimelock
handover the deployer EOA holds NONE of {DEFAULT_ADMIN_ROLE,
ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE} on the Gateway or the
vault. The Timelock receives the Gateway root (ADMIN + DEFAULT),
and an independent hot key receives the vault EMERGENCY_ROLE. This
is the deep deploy-assertion: it actually runs the handover and
enumerates every privileged role against the deployer EOA.


```solidity
function test_ACL1_eoaHoldsNoPrivilegedRoleAfterHandover() public;
```

### test_ACL7_agentRegistrationCannotBlockRoleGrant

ACL-7 / NC-10 (FLIPPED GREEN by #970): permissionless agent
registration can never block a future intended ADMIN/PAUSER address
from being granted its role during handover. Two layers prove this:
1. The Gateway's role-separation invariant means that if an intended
admin address were already an AGENT, `grantRole(ADMIN_ROLE, …)`
would revert `RoleSeparationViolated` — a confusing, late-stage
handover brick (the grant-DoS vector).
2. The DeployTimelock handover now ASSERTS up front (before any
gateway grant) that every address about to receive an
ADMIN/PAUSER-tier role is AGENT-free, turning the griefing vector
into an explicit, typed deploy-time precondition.
This test pins layer 1 (the brick exists without the guard) and
layer 2 (a normal handover, where no intended admin is pre-bound,
passes the guard and completes). Deep proof referenced by
FvInvariants.t.sol::test_ACL7_*.


```solidity
function test_ACL7_agentRegistrationCannotBlockRoleGrant() public;
```

### _acl7Policy

Minimal valid agent policy for the ACL-7 grant-DoS fixture.


```solidity
function _acl7Policy() internal returns (IGateway.AgentPolicy memory p);
```

### _deployAclFixtureAndHandover

Build the five-contract fixture (deployer = harness), delegate the
role-granting authority to the script, run the handover, and store the
handles in storage. Split out of the test body to stay under the EVM
stack-depth limit. Returns the deployed TimelockController address.


```solidity
function _deployAclFixtureAndHandover() internal returns (address timelock);
```

### test_ORA3_addAssetRevertsOnPoolMismatch

ORA-3 (FLIPPED GREEN by #966, F-09): BasketVault.addAsset reverts
when the execution pool resolved from `swapFee_` does not equal the
registered TWAP pool (here: the pool's own `fee()`), and SUCCEEDS
when they match. Pins the equality check the fix added.


```solidity
function test_ORA3_addAssetRevertsOnPoolMismatch() public;
```

### test_ORA6_chronicleAdapterDecimalsAssumptionIsDocumented

ORA-6 (HOLDS — 🟡 TRUSTED, F-17): documents the current decimals
trust assumption. The ChronicleOracleAdapter hardcodes the
1e12 = 10^(18-6) scale, correct only while the priced asset is
18-dec and USDC is 6-dec. This passing static-guard pins that the
hardcoded constant is still present (so a silent decimals change is
caught) and marks the seam where #966 would add the dynamic
`decimals()==18 && usdc.decimals()==6` constructor assertion.


```solidity
function test_ORA6_chronicleAdapterDecimalsAssumptionIsDocumented() public view;
```

