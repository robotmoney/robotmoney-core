# SafeIntegrationTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e725858583e4c0e5819bd858f896d04ded40bdb7/contracts/test/SafeIntegration.t.sol)

**Inherits:**
Test

**Title:**
SafeIntegrationTest

Fork-based integration tests proving that a 2-of-3 Safe proxy deployed via
`SafeProxyFactory` enforces quorum for all ADMIN_ROLE operations on the five
governed Robot Money contracts.

Tests run against a Base mainnet fork.  They are skipped when `FORK_RPC_URL` /
`RMPC_FORK_RPC_URL` is absent so that contributor laptops without an archive RPC
remain green.  CI sets `RMPC_FORK_RPC_URL` (same variable used by suite-05).
To run locally:
FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
forge test --match-contract SafeIntegration -vvv

Safe deployment approach:
We call `SafeProxyFactory.createProxyWithNonce` against the live Base-mainnet
factory (0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67) which points to the
canonical Safe singleton (0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 — L2 variant).
This proves the quorum is enforced by actual Safe contract code, not vm.prank.

EIP-712 signing:
Safe uses its own `SafeTx` struct for EIP-712 signing.  `getTransactionHash` on
the deployed proxy returns the correct domain-separated digest that owners sign.
We call `vm.sign(pk, digest)` for each owner key, then sort and pack signatures
into the `bytes` parameter of `execTransaction`.


## Constants
### SAFE_PROXY_FACTORY
Safe ProxyFactory on Base mainnet (same address across EVM chains).


```solidity
address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
```


### SAFE_SINGLETON_L2
Safe L2 singleton (implementation) on Base mainnet.
This is the SafeL2.sol variant that emits extra events for L2 indexers.


```solidity
address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
```


### SAFE_FALLBACK_HANDLER
Safe Compatibility Fallback Handler on Base mainnet.


```solidity
address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
```


### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### MIN_DELAY

```solidity
uint256 public constant MIN_DELAY = 2 days
```


## State Variables
### ownerPk1
Safe owner private keys — 3 signers, 2-of-3 threshold.


```solidity
uint256 internal ownerPk1
```


### ownerPk2

```solidity
uint256 internal ownerPk2
```


### ownerPk3

```solidity
uint256 internal ownerPk3
```


### owner1

```solidity
address internal owner1
```


### owner2

```solidity
address internal owner2
```


### owner3

```solidity
address internal owner3
```


### safe
The deployed 2-of-3 Safe proxy.


```solidity
ISafe internal safe
```


### vault
The five governed contracts.


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


### usdc

```solidity
TestERC20 internal usdc
```


### d
Deployed timelock wiring.


```solidity
DeployTimelock.Deployed internal d
```


### _snap
Snapshot id used for per-test isolation.


```solidity
uint256 internal _snap
```


## Functions
### _trySelectFork

Read the fork URL from environment, create + select fork.
Returns false when no URL is configured (caller should skip).


```solidity
function _trySelectFork() internal returns (bool);
```

### setUp

Deploy the five governed contracts, wire them to a fresh TimelockController
whose PROPOSER is the deployed 2-of-3 Safe proxy.


```solidity
function setUp() public;
```

### withSnap

Revert to post-setUp snapshot before each test.


```solidity
modifier withSnap() ;
```

### _sortedOwners

Return owners sorted ascending by address (Safe requirement).


```solidity
function _sortedOwners() internal view returns (address[] memory owners);
```

### _pkFor

Get private key for a given owner address.


```solidity
function _pkFor(address owner) internal view returns (uint256);
```

### _buildTwoOwnerSigs

Build a 2-of-3 packed signature for a Safe transaction hash.
Signs with the two lowest-address owners (sorted ascending — Safe requirement).


```solidity
function _buildTwoOwnerSigs(bytes32 txHash) internal view returns (bytes memory);
```

### _buildOneOwnerSig

Build a 1-of-3 packed signature (only one owner signs — quorum not met).


```solidity
function _buildOneOwnerSig(bytes32 txHash) internal view returns (bytes memory);
```

### _signOne

Sign `txHash` with a single non-owner key and return the 65-byte sig.


```solidity
function _signOne(uint256 pk, bytes32 txHash) internal view returns (bytes memory sig65);
```

### _buildWrongSignerSigs

Build a 2-signer signature using two private keys NOT in the Safe owner set.
Splits signing into a helper to stay within the stack-depth limit.


```solidity
function _buildWrongSignerSigs(bytes32 txHash) internal view returns (bytes memory);
```

### _safeExec

Execute a Safe transaction that calls `callData` on `target`.
Builds the EIP-712 hash, signs with two owners, calls execTransaction.


```solidity
function _safeExec(address target, bytes memory callData, bytes memory signatures)
    internal
    returns (bool);
```

### _scheduleAndExecute

Schedule an operation through the TimelockController via the Safe, then
mine the delay and execute. Returns when the operation is done.


```solidity
function _scheduleAndExecute(address target, bytes memory callData) internal;
```

### _forkAvailable

Returns true if the fork was successfully selected (setUp ran).
If not, the caller should return immediately (skip).


```solidity
function _forkAvailable() internal view returns (bool);
```

### test_happyPath_vaultRegistry_registerVault

AC1a: Full Safe.execTransaction() → schedule → mine delay → execute on VaultRegistry.


```solidity
function test_happyPath_vaultRegistry_registerVault() public withSnap;
```

### test_happyPath_portfolioRouter_setRouterCap

AC1b: Full Safe+timelock path on PortfolioRouter (setRouterCap).


```solidity
function test_happyPath_portfolioRouter_setRouterCap() public withSnap;
```

### test_happyPath_routerGovernance_setQuorumThreshold

AC1c: Full Safe+timelock path on RouterGovernance (setQuorumThreshold).


```solidity
function test_happyPath_routerGovernance_setQuorumThreshold() public withSnap;
```

### test_happyPath_vault_setExitFeeBps

AC1d: Full Safe+timelock path on RobotMoneyVault (setExitFeeBps).


```solidity
function test_happyPath_vault_setExitFeeBps() public withSnap;
```

### test_happyPath_gateway_adminRoleGrant

AC1e: Full Safe+timelock path on RobotMoneyGateway (ADMIN_ROLE grant).


```solidity
function test_happyPath_gateway_adminRoleGrant() public withSnap;
```

### test_sadPath_quorumNotMet_oneSignerReverts

AC2: One signature from a 2-of-3 Safe reverts inside execTransaction.


```solidity
function test_sadPath_quorumNotMet_oneSignerReverts() public withSnap;
```

### test_sadPath_wrongSigners_revert

AC3: Two signatures from addresses not in the Safe owner set revert.


```solidity
function test_sadPath_wrongSigners_revert() public withSnap;
```

### test_sadPath_preDelayExecute_reverts

AC4: TimelockController.execute() before min delay elapses reverts.


```solidity
function test_sadPath_preDelayExecute_reverts() public withSnap;
```

### test_sadPath_replay_reverts

AC5: Replaying an already-executed Safe+timelock operation reverts.


```solidity
function test_sadPath_replay_reverts() public withSnap;
```

### test_sadPath_directAdminBypass_vaultRegistry

AC6a: Direct ADMIN_ROLE call on VaultRegistry reverts.


```solidity
function test_sadPath_directAdminBypass_vaultRegistry() public withSnap;
```

### test_sadPath_directAdminBypass_portfolioRouter

AC6b: Direct ADMIN_ROLE call on PortfolioRouter reverts.


```solidity
function test_sadPath_directAdminBypass_portfolioRouter() public withSnap;
```

### test_sadPath_directAdminBypass_routerGovernance

AC6c: Direct ADMIN_ROLE call on RouterGovernance reverts.


```solidity
function test_sadPath_directAdminBypass_routerGovernance() public withSnap;
```

### test_sadPath_directAdminBypass_vault

AC6d: Direct ADMIN_ROLE call on RobotMoneyVault reverts.


```solidity
function test_sadPath_directAdminBypass_vault() public withSnap;
```

### test_sadPath_directAdminBypass_gateway

AC6e: Direct ADMIN_ROLE call on RobotMoneyGateway reverts.


```solidity
function test_sadPath_directAdminBypass_gateway() public withSnap;
```

### test_sadPath_directAdminBypass_stranger

AC6f: Direct ADMIN_ROLE call from random EOA reverts (all contracts).


```solidity
function test_sadPath_directAdminBypass_stranger() public withSnap;
```

### test_sadPath_cancelledOperation_cannotExecute

AC7: A cancelled timelock operation cannot be executed after cancellation.


```solidity
function test_sadPath_cancelledOperation_cannotExecute() public withSnap;
```

