# AgentTokenVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/49fdc0c3c31bec47921788de2ceaba90e0447685/contracts/vaults/AgentTokenVault.sol)

**Inherits:**
[BasketVault](/contracts/vaults/BasketVault.sol/abstract.BasketVault.md)

**Title:**
AgentTokenVault

PROTOTYPE ERC-4626 USDC vault holding a basket of agent-economy tokens
curated by ADMIN_ROLE. Swaps in/out via Uniswap V3.
The shortlist is admin-controlled for this prototype. In production this
will be replaced by on-chain RM-token governance or a bribery mechanism
(see docs/prd.md open questions §1.3, §1.4, §3.2).
Depositors receive rmAGENT shares. Basket contents change only when
admin adds or removes assets. Existing positions are unaffected until
the vault is rebalanced or the user redeems.
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
    address admin_
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
        admin_
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

