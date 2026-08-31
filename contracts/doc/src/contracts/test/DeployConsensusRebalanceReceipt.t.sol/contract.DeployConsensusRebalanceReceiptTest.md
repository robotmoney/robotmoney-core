# DeployConsensusRebalanceReceiptTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/743c60bd2a8cdaa5170640645e0c5bf35685c012/contracts/test/DeployConsensusRebalanceReceipt.t.sol)

**Inherits:**
Test

**Title:**
DeployConsensusRebalanceReceiptTest

AC10: the receipt contract deploys **alongside**
InvestmentCommitteePolicy in one ceremony, and AC2: `ADMIN_ROLE` on
the receipt contract lands on the `TimelockController` and nowhere
else. This is a single greenfield rollout — no migration and no
registered agent to preserve.


## State Variables
### admin

```solidity
address admin = address(0xA0)
```


### pauser

```solidity
address pauser = address(0xA1)
```


### submitter

```solidity
address submitter = address(0xB1)
```


### proposer

```solidity
address proposer = address(0xC0)
```


### executor

```solidity
address executor = address(0xC1)
```


### usdc

```solidity
TestERC20 usdc
```


### vault

```solidity
MockVault vault
```


### gateway

```solidity
RobotMoneyGateway gateway
```


### timelock

```solidity
TimelockController timelock
```


### script

```solidity
DeployInvestmentCommitteePolicy script
```


### d

```solidity
DeployInvestmentCommitteePolicy.Deployed d
```


## Functions
### setUp


```solidity
function setUp() public;
```

### testOneCeremonyDeploysAndWiresBoth

AC10: both contracts exist after a single ceremony, and both are
wired into the gateway.


```solidity
function testOneCeremonyDeploysAndWiresBoth() public view;
```

### testReceiptAdminRoleIsTimelockOnly

AC2 / INV-3: `ADMIN_ROLE` on the receipt contract is held by the
TimelockController — and by nobody else, including the gateway,
the deployer, and the protocol admin.


```solidity
function testReceiptAdminRoleIsTimelockOnly() public view;
```

### testDeployedWiringAnchorsAndReleases

The as-deployed wiring actually anchors: an allowlisted submitter
records through the gateway and only the timelock can release.


```solidity
function testDeployedWiringAnchorsAndReleases() public;
```

