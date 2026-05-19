# VaultForkRegressions
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/VaultForkRegressions.t.sol)

**Inherits:**
Test

**Title:**
VaultForkRegressions

Fork-level regression suite for vault accounting attack paths.

These tests run against a live Base mainnet fork.  They are skipped
cleanly when the `FORK_RPC_URL` environment variable is absent so that
contributor laptops without an archive RPC remain green.
To run locally:
FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
forge test --match-path "contracts/test/VaultForkRegressions.t.sol" -vvv
In CI the secret is `RMPC_FORK_RPC_URL` (same variable used by the
suite-05 fork workflow).  The job sets it before calling forge test so
these tests execute rather than skip.
Attack paths covered (per issue #209 acceptance criteria):
AC1  Aave adapter donation cannot make a victim deposit mint zero/unfair shares.
AC2  Morpho adapter donation cannot make a victim deposit mint zero/unfair shares.
AC3  Compound adapter donation cannot make a victim deposit mint zero/unfair shares.
AC4  Direct USDC transfer to vault is included in totalAssets / TVL-cap path.
AC5  Unrouted deposit emits UnroutedDeposit and the idle balance is observable.
AC6  MorphoAdapter.withdraw returns actual delivered USDC under fork conditions.


## Constants
### BASE_USDC
Real USDC on Base (Circle).


```solidity
address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```


### AAVE_POOL
Aave V3 Pool on Base.


```solidity
address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
```


### AAVE_A_TOKEN
aBasUSDC rebasing token — balanceOf returns live underlying USDC.


```solidity
address internal constant AAVE_A_TOKEN = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB
```


### MORPHO_VAULT
Morpho Gauntlet USDC Prime vault on Base (ERC-4626).


```solidity
address internal constant MORPHO_VAULT = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca
```


### COMPOUND_COMET
Compound V3 Comet (cUSDCv3) on Base.


```solidity
address internal constant COMPOUND_COMET = 0xB125e6687D4313864e53df431d5425969c15eb28
```


### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### SEED_AMOUNT

```solidity
uint256 internal constant SEED_AMOUNT = 1_000 * ONE_USDC
```


### DONATION_AMOUNT

```solidity
uint256 internal constant DONATION_AMOUNT = 1_000_000 * ONE_USDC
```


### VICTIM_DEPOSIT

```solidity
uint256 internal constant VICTIM_DEPOSIT = 100_000 * ONE_USDC
```


### TVL_CAP

```solidity
uint256 internal constant TVL_CAP = 1_000_000_000 * ONE_USDC
```


### PER_DEPOSIT_CAP

```solidity
uint256 internal constant PER_DEPOSIT_CAP = 100_000_000 * ONE_USDC
```


## State Variables
### usdc

```solidity
IERC20 internal usdc
```


### admin

```solidity
address internal admin
```


### feeRecipient

```solidity
address internal feeRecipient
```


### alice

```solidity
address internal alice
```


### attacker

```solidity
address internal attacker
```


## Functions
### _forkRpcUrl

Attempt to read FORK_RPC_URL / RMPC_FORK_RPC_URL.
Returns "" if neither is set so callers can skip gracefully.


```solidity
function _forkRpcUrl() internal view returns (string memory url);
```

### _trySelectFork

Create and select a Base mainnet fork.  Returns false (skip signal)
when no RPC URL is configured, so the outer test can skip cleanly.


```solidity
function _trySelectFork() internal returns (bool selected);
```

### _setUp

Shared preamble: select fork, fund accounts.
Returns false when the fork URL is absent (test should skip).


```solidity
function _setUp() internal returns (bool);
```

### _deployVaultWithAdapter

Deploy a fresh RobotMoneyVault with a single adapter.
Approves the vault from alice and attacker.


```solidity
function _deployVaultWithAdapter(address adapter_) internal returns (RobotMoneyVault vault_);
```

### _allowAdapter


```solidity
function _allowAdapter(RobotMoneyVault vault_, address adapter_) internal;
```

### _assertDonationAttackFails

Core attack scenario:
1. Attacker seeds the vault with 1 wei.
2. Attacker donates `donationAmt` USDC to the adapter via the protocol
directly (bypassing the vault minting path), using `deal()` +
adapter-level deposit.  The donation increases the adapter's
reported `totalAssets()` without minting any vault shares.
3. Victim deposits `victimDeposit` USDC.
4. Asserts victim receives non-zero shares and can recover ≥ 90% of value.
The 90% floor is intentionally generous; the actual protection from the
18-decimals offset makes the loss negligible, but a hard floor catches
regressions that silently remove the offset.


```solidity
function _assertDonationAttackFails(
    RobotMoneyVault vault_,
    IStrategyAdapter adapter_,
    uint256 donationAmt,
    uint256 victimDeposit
) internal;
```

### test_fork_aave_donationAttack_victimSharesFair

AC1: Aave adapter donation cannot make victim deposit mint zero/unfair shares.

Deploys vault + AaveV3Adapter against real Base Aave pool.
Seeds vault, donates USDC directly into adapter balance, asserts victim fairness.


```solidity
function test_fork_aave_donationAttack_victimSharesFair() public;
```

### test_fork_morpho_donationAttack_victimSharesFair

AC2: Morpho adapter donation cannot make victim deposit mint zero/unfair shares.

Deploys vault + MorphoAdapter against real Base Morpho Gauntlet USDC Prime vault.


```solidity
function test_fork_morpho_donationAttack_victimSharesFair() public;
```

### test_fork_compound_donationAttack_victimSharesFair

AC3: Compound adapter donation cannot make victim deposit mint zero/unfair shares.

Deploys vault + CompoundV3Adapter against real Base Compound Comet.


```solidity
function test_fork_compound_donationAttack_victimSharesFair() public;
```

### test_fork_directTransfer_countedInTotalAssets

AC4: A direct USDC transfer to the vault (not via deposit) is included
in totalAssets() and the TVL-cap enforcement path.

Uses AaveV3Adapter for a realistic adapter setup; the idle-balance
logic is independent of which adapter is present.


```solidity
function test_fork_directTransfer_countedInTotalAssets() public;
```

### test_fork_directTransfer_causesCapEnforcement

AC4 (TVL-cap path): idle USDC is counted when enforcing the cap.

Tightly-capped vault: caps chosen so idle balance pushes total close
to the ceiling, and a further deposit should revert.


```solidity
function test_fork_directTransfer_causesCapEnforcement() public;
```

### test_fork_unroutedDeposit_emitsEventAndStaysIdle

AC5: When adapter caps are exhausted, the unrouted portion stays idle
in the vault and the UnroutedDeposit event is emitted — not silent.

A single adapter capped at 50% means half of the first deposit is
unroutable.  The event and idle balance are both verifiable.


```solidity
function test_fork_unroutedDeposit_emitsEventAndStaysIdle() public;
```

### test_fork_morphoAdapter_withdrawReturnsActualDelivered

AC6: MorphoAdapter.withdraw returns the actual USDC delivered to the
vault under fork conditions (not a synthetic count).

Deploys the vault with MorphoAdapter, performs a deposit to push USDC
into the Morpho vault, then triggers a withdrawal and verifies:
- The returned value equals the actual USDC received by the vault.
- No shortfall: Morpho delivers exactly what was requested.


```solidity
function test_fork_morphoAdapter_withdrawReturnsActualDelivered() public;
```

### test_fork_vaultInvariants_decimalsOffsetAndShareMinting

Confirm the fork harness does not weaken existing local coverage:
decimals offset and share minting invariants hold on a live fork.


```solidity
function test_fork_vaultInvariants_decimalsOffsetAndShareMinting() public;
```

