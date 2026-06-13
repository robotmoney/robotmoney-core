# DeploySeedDeposit
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/eddfc6a75fd5558f18f4c48ae13aa1c3278c17e6/contracts/test/DeploySeedDeposit.t.sol)

**Inherits:**
Test

**Title:**
DeploySeedDeposit

Fork test asserting that after running the deploy script the vault
satisfies the seed deposit precondition required by the deploy runbook:
- vault.totalAssets() >= 1_000 * 1e6 (1,000 USDC)
- vault.totalSupply() > 0
before any simulated public deposit.

These tests run against a live Base mainnet fork.  They skip cleanly
when neither `FORK_RPC_URL` nor `RMPC_FORK_RPC_URL` is set so that
contributor laptops without an archive RPC remain green.
To run locally:
FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
forge test --match-contract DeploySeedDeposit --fork-url $FORK_RPC_URL -vvv
In CI the secret is `RMPC_FORK_RPC_URL` (same variable used by the
suite-01-02 fork-regressions job).  The job sets it before calling
forge test so these tests execute rather than skip.
See docs/technical/security-model.md §3 and docs/technical/smart-contracts.md §8.3.


## Constants
### BASE_USDC
Real USDC on Base (Circle FiatTokenProxy).


```solidity
address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```


## State Variables
### admin

```solidity
address internal admin
```


### pauser

```solidity
address internal pauser
```


### agent

```solidity
address internal agent
```


### shareReceiver

```solidity
address internal shareReceiver
```


### script

```solidity
Deploy internal script
```


## Functions
### _forkRpcUrl

Attempt to read FORK_RPC_URL / RMPC_FORK_RPC_URL.
Returns "" if neither is set so callers can skip gracefully.


```solidity
function _forkRpcUrl() internal view returns (string memory);
```

### _trySelectFork

Create and select a Base mainnet fork.
Returns false (skip signal) when no RPC URL is configured.


```solidity
function _trySelectFork() internal returns (bool);
```

### _setUp

Shared setup: create the deploy script, named test accounts,
and ensure admin has enough USDC for the seed deposit.
Returns false when the fork URL is absent (test should skip).


```solidity
function _setUp() internal returns (bool);
```

### _runDeploy

Run the deploy script in-process with real Base USDC and seed deposit.
Adapters are deployed against real Base mainnet protocol addresses.
Uses runInProcessWithSeed() which includes the mandatory seed deposit step.


```solidity
function _runDeploy() internal returns (Deploy.Deployed memory);
```

### test_fork_deploySeed_totalAssetsAtLeastMinSeed

After deploy, vault.totalAssets() >= 1_000_000_000 (1,000 USDC).
This is the primary AC from issue #656: the deploy runbook must
seed the vault with ≥ 1,000 USDC before the vault is opened to
the public (security-model.md §3).


```solidity
function test_fork_deploySeed_totalAssetsAtLeastMinSeed() public;
```

### test_fork_deploySeed_totalSupplyPositive

After deploy, vault.totalSupply() > 0.
A zero totalSupply before the first public deposit would leave
the vault vulnerable to the inflation attack despite the 18-decimal
offset.  The seed deposit eliminates this window.


```solidity
function test_fork_deploySeed_totalSupplyPositive() public;
```

### test_fork_deploySeed_adminHoldsShares

Admin (deployer) holds seed shares after deploy.
The seed deposit mints shares to the admin/deployer; the
public cannot exploit a zero-supply state even briefly.


```solidity
function test_fork_deploySeed_adminHoldsShares() public;
```

### test_fork_deploySeed_firstPublicDepositReceivesFairShares

A public deposit made immediately after deploy mints fair shares.
This is the downstream consequence of the seed precondition:
a first public depositor cannot be front-run by an inflation attacker
because the vault already has positive supply and assets.


```solidity
function test_fork_deploySeed_firstPublicDepositReceivesFairShares() public;
```

