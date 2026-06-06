# AgentTokenVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/690ce3eb1d770c8624dfe2b7c8dc1fb69a34bcd3/contracts/vaults/AgentTokenVault.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

**Title:**
AgentTokenVault

ERC-4626 USDC vault holding a basket of agent-economy tokens curated
via a governed shortlist. Swaps in/out via Uniswap V3.
## Shortlist governance (ADR-0004)
In production, ADMIN_ROLE is held by a TimelockController deployed by
DeployTimelock.s.sol. The Safe (≥2-of-3 multisig) is the sole PROPOSER.
Every shortlist change must flow through the timelock:
- `addAsset`    — minimum 48-hour delay before execution
- `removeAsset` — minimum 24-hour delay before execution
During the delay window any observer may inspect the pending change via
the `TimelockController.CallScheduled` event and raise a public challenge.
Any Safe signer may cancel a queued change unilaterally via
`TimelockController.cancel(id)` before execution (veto path).
The `CANCELLER_ROLE` on `TimelockController` may later be extended to an
RM-token veto module (Option B in ADR-0004) without redeploying this vault.
## addAsset gate criteria (ADR-0004)
Before proposing a new token via TimelockController, the Safe MUST verify:
- Market cap ≥ $10M 30-day trailing average
- Listing age ≥ 90 days on-chain (Base or bridged)
- Daily volume ≥ $100K 30-day trailing average
- Holder count ≥ 500 distinct holders
- Oracle: Uniswap V3 pool on Base with ≥ 30-day TWAP history for the
USDC pair (or a Chainlink feed with ≥ 30-day history)
- Liquidity depth ≥ $50K within 2% of mid-price on the primary
Uniswap V3 pool (synchronous-redemption guarantee at ≤300 bps slippage)
Gate evidence is recorded in the TimelockController.schedule() calldata
or as a linked off-chain hash (IPFS CID or governance-forum post URL).
The contract enforces pool cardinality and token/USDC pairing on-chain
via BasketVault.addAsset(); all other gate criteria are verified off-chain
by the Safe signers at proposal time.
## Operational notes
The canonical MVP shortlist (six Base-only tokens, equal-weight) is seeded
from config/agent-token-shortlist.json via
contracts/script/DeployAgentTokenVault.s.sol — no token address is
hardcoded here.
Depositors receive rmAGENT shares. Basket contents change only when
admin adds or removes assets via the timelock path. Existing positions
are unaffected until the vault is rebalanced or the user redeems.
Risk label: SPECULATIVE — agent tokens are volatile and may have
limited swap liquidity. Set slippageBps accordingly per shortlist.
Base mainnet SwapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481


## Constants
### _MAX_ASSETS

```solidity
uint256 private constant _MAX_ASSETS = 15
```


### _DEFAULT_SLIPPAGE_BPS

```solidity
uint256 private constant _DEFAULT_SLIPPAGE_BPS = 300
```


### SHORTLIST_ADD_DELAY
Minimum timelock delay required for addAsset proposals (48 hours).
Enforced off-chain by the Safe signers; recorded here for reference
and off-chain monitoring tooling.


```solidity
uint256 public constant SHORTLIST_ADD_DELAY = 48 hours
```


### SHORTLIST_REMOVE_DELAY
Minimum timelock delay required for removeAsset proposals (24 hours).
Enforced off-chain by the Safe signers; recorded here for reference
and off-chain monitoring tooling.


```solidity
uint256 public constant SHORTLIST_REMOVE_DELAY = 24 hours
```


## Functions
### constructor


```solidity
constructor(
    IERC20 usdc_,
    ISwapRouter swapRouter_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    address feeRecipient_,
    address admin_,
    address emergencyResponder_
)
    BasketVault(
        "Robot Money Agent Tokens",
        "rmAGENT",
        usdc_,
        swapRouter_,
        tvlCap_,
        perDepositCap_,
        exitFeeBps_,
        _DEFAULT_SLIPPAGE_BPS,
        feeRecipient_,
        admin_,
        emergencyResponder_
    );
```

### maxAssets


```solidity
function maxAssets() public pure override returns (uint256);
```

### shortlist

Returns token address, pool, swap fee, active flag, and current vault balance
for every shortlist entry. Intended for off-chain display and rmpc reads.


```solidity
function shortlist()
    external
    view
    returns (
        address[] memory tokens,
        address[] memory pools,
        uint24[] memory fees,
        bool[] memory active,
        uint256[] memory balances
    );
```

