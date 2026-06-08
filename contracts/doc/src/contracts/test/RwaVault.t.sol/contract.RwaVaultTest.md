# RwaVaultTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/54c7918eefdea420a15bda61e204c809879c6e71/contracts/test/RwaVault.t.sol)

**Inherits:**
Test

**Title:**
RwaVaultTest

Unit tests for the deSPXA RWA vault.
Acceptance criteria verified:
AC-1: RWA vault holds deSPXA and round-trips USDC->deSPXA->USDC via Aerodrome.
AC-2: Pricing uses Chronicle NAV oracle; no ERC-7540 primary NAV redemption path.
AC-3: Caps, pause, and freeze-path safety are covered by forge tests.
Decimal conventions:
USDC   — 6 decimals (TestERC20)
deSPXA — 18 decimals (TestERC20_18, matching real deSPXA on Base)
Chronicle price — WAD (18 dec): USDC value of 1 deSPXA, both 18-dec scaled
e.g. NAV_PRICE_WAD = 5e18 means 1 deSPXA = 5 USDC
Adapter formula (ChronicleOracleAdapter.twapPrice):
deSPXA→USDC: quoteUSDC = baseDesplxa * navPrice / (WAD * 1e12)
e.g. 1e18 deSPXA * 5e18 / (1e18 * 1e12) = 5e6 USDC ✓
USDC→deSPXA: quoteDespxa = baseUsdc * 1e12 * WAD / navPrice
e.g. 5e6 USDC * 1e12 * 1e18 / 5e18 = 1e18 deSPXA ✓
All tests use mock contracts — no mainnet fork needed.


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### ONE_DESPXA

```solidity
uint256 internal constant ONE_DESPXA = 1e18
```


### NAV_PRICE_WAD
Chronicle reports price in WAD: 5.00 USDC per deSPXA.


```solidity
uint256 internal constant NAV_PRICE_WAD = 5e18
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### despxa

```solidity
TestERC20_18 internal despxa
```


### chronicle

```solidity
MockChronicle internal chronicle
```


### aeroRouter

```solidity
MockAerodromeRouter internal aeroRouter
```


### pool

```solidity
MockDeSPXAPool internal pool
```


### adapter

```solidity
ChronicleOracleAdapter internal adapter
```


### vault

```solidity
RwaVault internal vault
```


### admin

```solidity
address internal admin
```


### emergencyResponder

```solidity
address internal emergencyResponder
```


### user

```solidity
address internal user
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deposit_swapsUsdcToDespxa

Depositing USDC causes the vault to swap USDC → deSPXA via Aerodrome.
deSPXA (18-decimal) is held by the vault after deposit.
AC-1: round-trip USDC→deSPXA→USDC via Aerodrome.


```solidity
function test_deposit_swapsUsdcToDespxa() public;
```

### test_redeem_swapsDespxaToUsdc

Redeeming shares causes the vault to swap deSPXA → USDC via Aerodrome.
AC-1: round-trip USDC→deSPXA→USDC via Aerodrome.


```solidity
function test_redeem_swapsDespxaToUsdc() public;
```

### test_totalAssets_returnsZeroWhenEmpty

totalAssets is zero for an empty vault.


```solidity
function test_totalAssets_returnsZeroWhenEmpty() public;
```

### test_totalAssets_pricedViaChronicle

totalAssets reflects Chronicle NAV pricing, not Aerodrome spot.
100 deSPXA @ 5 USDC/deSPXA = 500 USDC NAV.


```solidity
function test_totalAssets_pricedViaChronicle() public;
```

### test_chronicle_priceRwaToUsdc

Chronicle price direction: RWA→USDC.
AC-2: pricing uses Chronicle NAV oracle.


```solidity
function test_chronicle_priceRwaToUsdc() public view;
```

### test_chronicle_priceUsdcToRwa

Chronicle price direction: USDC→RWA.
AC-2: pricing uses Chronicle NAV oracle.


```solidity
function test_chronicle_priceUsdcToRwa() public view;
```

### test_chronicle_zeroInputReturnsZero

Chronicle price returns 0 for zero input (no revert).


```solidity
function test_chronicle_zeroInputReturnsZero() public view;
```

### test_chronicle_revertsOnUnknownPair

Chronicle price reverts on unknown pair.


```solidity
function test_chronicle_revertsOnUnknownPair() public;
```

### test_staleFeed_totalAssetsReverts

totalAssets() reverts with StalePriceFeed when oracle is stale.
AC-2: pricing uses Chronicle NAV oracle; stale feed halts operations.


```solidity
function test_staleFeed_totalAssetsReverts() public;
```

### test_staleFeed_depositReverts

Deposits revert when the oracle is stale (totalAssets is on the hot path).


```solidity
function test_staleFeed_depositReverts() public;
```

### test_staleFeed_resumesAfterOracleRefresh

Operations resume after the oracle is refreshed.


```solidity
function test_staleFeed_resumesAfterOracleRefresh() public;
```

### test_caps_perDepositCapEnforced

Deposits above the per-deposit cap revert with PerDepositCapExceeded.
AC-3: caps are enforced.


```solidity
function test_caps_perDepositCapEnforced() public;
```

### test_caps_tvlCapEnforced

Deposits above the TVL cap revert with TVLCapExceeded.
AC-3: caps are enforced.


```solidity
function test_caps_tvlCapEnforced() public;
```

### test_pause_haltsThenResumes

pause() halts deposits; unpause() resumes them.
AC-3: pause/unpause are covered.


```solidity
function test_pause_haltsThenResumes() public;
```

### test_pause_onlyEmergencyRole

Only EMERGENCY_ROLE can pause; strangers are rejected.


```solidity
function test_pause_onlyEmergencyRole() public;
```

### test_freeze_depositRevertsGracefullyWithNoSharesMinted

When deSPXA transfers are frozen (issuer freeze), the Aerodrome swap
reverts. The vault DOES NOT confiscate shares — no shares are minted.
AC-3: freeze-path safety — no fund loss on failed deposit.


```solidity
function test_freeze_depositRevertsGracefullyWithNoSharesMinted() public;
```

### test_freeze_adminCanPauseAfterFreeze

Admin can pause the vault after a freeze is detected (ADR-0006 §4).
Subsequent deposits revert with user-facing EnforcedPause, not opaque ERC-20 error.
AC-3: freeze-path safety — admin pause mechanism.


```solidity
function test_freeze_adminCanPauseAfterFreeze() public;
```

### test_freeze_existingHoldersRetainShares

Existing holders retain their shares during a freeze — vault never
confiscates or redistributes rmRWA shares. (ADR-0006 §4)


```solidity
function test_freeze_existingHoldersRetainShares() public;
```

### test_metadata_nameAndSymbol

RwaVault name and symbol match the product spec (ADR-0006, PRD §11.4).


```solidity
function test_metadata_nameAndSymbol() public view;
```

### test_metadata_maxAssetsIsOne

maxAssets is 1 — only one basket asset is permitted (deSPXA).


```solidity
function test_metadata_maxAssetsIsOne() public view;
```

### test_maxAssets_rejectsSecondAsset

Adding a second asset reverts with MaxAssetsReached.


```solidity
function test_maxAssets_rejectsSecondAsset() public;
```

### test_oracleHeartbeat_adminCanUpdate

ADMIN_ROLE can update the oracle heartbeat within bounds.


```solidity
function test_oracleHeartbeat_adminCanUpdate() public;
```

### test_oracleHeartbeat_rejectsAboveMax

Heartbeat > MAX_HEARTBEAT (48h) reverts with InvalidHeartbeat.


```solidity
function test_oracleHeartbeat_rejectsAboveMax() public;
```

### test_oracleHeartbeat_rejectsBelowMin

Heartbeat < 1h reverts with InvalidHeartbeat.


```solidity
function test_oracleHeartbeat_rejectsBelowMin() public;
```

### test_oracleHeartbeat_emitsEvent

OracleHeartbeatUpdated event is emitted on heartbeat update.


```solidity
function test_oracleHeartbeat_emitsEvent() public;
```

### test_adapter_rejectsZeroRouter

ChronicleOracleAdapter rejects zero-address for router.


```solidity
function test_adapter_rejectsZeroRouter() public;
```

### test_adapter_rejectsZeroOracle

ChronicleOracleAdapter rejects zero-address for oracle.


```solidity
function test_adapter_rejectsZeroOracle() public;
```

### test_vault_rejectsZeroChronicle

RwaVault rejects zero-address for Chronicle oracle.


```solidity
function test_vault_rejectsZeroChronicle() public;
```

