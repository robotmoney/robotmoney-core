# DeployTimelockCommitteeTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/0df8fdff297aedb1734e0e690175f52c7720f0e1/contracts/test/DeployTimelockCommittee.t.sol)

**Inherits:**
Test

**Title:**
DeployTimelockCommitteeTest

Issue #1319: before this change, `DeployTimelock.s.sol` only handed
ADMIN_ROLE over to the timelock for the five core protocol
contracts, leaving InvestmentCommitteePolicy and
ConsensusRecommendationReceipt's ADMIN_ROLE/DEFAULT_ADMIN_ROLE on
an EOA after the "one ceremony" (#1247 AC10) — violating INV-3.
These tests exercise `runInProcessWithCommittee` and prove: (1) the
timelock ends up holding both roles on both contracts, (2) the
real deployer identity loses both roles, (3) a third-party role
holder that must survive the handover (the gateway's ADMIN_ROLE on
the IC policy, granted separately per docs/architecture.md §4.9)
is untouched, and (4) the ceremony fails loudly — never silently —
when the configured receipt admin does not match who is actually
authorized to run the handover.
In-process identity note (mirrors contracts/test/fv/DeployAssertions.t.sol):
when a test calls `script.runInProcessWithCommittee(...)` directly,
`msg.sender` INSIDE the script's own code is `address(this)` (the
test contract) — that is the value substituted wherever the script
revokes "from msg.sender" or defaults `receiptAdmin_ == address(0)`
to it. But when the script's internal code calls OUT to a target
contract (e.g. `icPolicy.grantRole(...)`), that target sees the
caller as `address(script)` (the script contract itself), because
the call originates from within the script's own code. So for a
grant/revoke round-trip to both succeed AND genuinely move a real
role, each committee contract here is constructed with
`address(this)` as its admin (matching the revoke-target identity)
AND separately grants `address(script)` the same roles (matching
the grant/revoke authority every one of the script's external
calls actually executes under).


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### DEFAULT_ADMIN_ROLE

```solidity
bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00
```


### MIN_DELAY

```solidity
uint256 public constant MIN_DELAY = 2 days
```


## State Variables
### pauser

```solidity
address internal pauser = makeAddr("pauser")
```


### safe

```solidity
address internal safe
```


### emergency

```solidity
address internal emergency = makeAddr("emergency")
```


### independentReceiptAdmin
A genuinely independent receipt admin (issue #1319 amendment: the
receipt's admin is RECEIPT_ADMIN_ADDRESS, "not necessarily the
deployer"). Used only in the negative/loud-failure test.


```solidity
address internal independentReceiptAdmin = makeAddr("independentReceiptAdmin")
```


### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
RobotMoneyVault internal vault
```


### gateway

```solidity
RobotMoneyGateway internal gateway
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### governance

```solidity
RouterGovernance internal governance
```


### icPolicy

```solidity
InvestmentCommitteePolicy internal icPolicy
```


### script

```solidity
DeployTimelock internal script
```


### d

```solidity
DeployTimelock.Deployed internal d
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _deployReceiptAndRun

Deploys the receipt contract with the given constructor admin and
runs the full seven-contract ceremony through
`runInProcessWithCommittee`.


```solidity
function _deployReceiptAndRun(address receiptConstructedAdmin, address receiptAdminArg)
    internal
    returns (ConsensusRecommendationReceipt receipts);
```

### test_timelock_holdsBothRolesOnICPolicy


```solidity
function test_timelock_holdsBothRolesOnICPolicy() public;
```

### test_deployer_noLongerHasRolesOnICPolicy


```solidity
function test_deployer_noLongerHasRolesOnICPolicy() public;
```

### test_gateway_stillHasAdminRoleOnICPolicy_afterHandover

The gateway's ADMIN_ROLE on the IC policy — a second,
intentional holder unrelated to the deployer handover — must
survive untouched.


```solidity
function test_gateway_stillHasAdminRoleOnICPolicy_afterHandover() public;
```

### test_timelock_holdsBothRolesOnReceipt


```solidity
function test_timelock_holdsBothRolesOnReceipt() public;
```

### test_deployer_noLongerHasRolesOnReceipt


```solidity
function test_deployer_noLongerHasRolesOnReceipt() public;
```

### test_receiptAdminExplicit_handoverSucceeds


```solidity
function test_receiptAdminExplicit_handoverSucceeds() public;
```

### test_zeroCommitteeAddresses_skipsHandover_fiveCoreStillWorks


```solidity
function test_zeroCommitteeAddresses_skipsHandover_fiveCoreStillWorks() public;
```

### test_receiptAdmin_notAuthorized_revertsLoudly


```solidity
function test_receiptAdmin_notAuthorized_revertsLoudly() public;
```

