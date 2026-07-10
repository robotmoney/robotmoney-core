# MockMorpho4626
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/test/ERC4626PreconditionChecks.t.sol)

**Title:**
Minimal ERC-4626 Morpho-vault stand-in.

Only the surface `MorphoAdapter.totalAssets()` touches —
`balanceOf` and `convertToAssets` — is implemented. An empty
adapter holds zero shares, so `convertToAssets(0) == 0`.


## Functions
### balanceOf

Adapter holds no shares in any precondition scenario.


```solidity
function balanceOf(address) external pure returns (uint256);
```

### convertToAssets

1:1 share↔asset stub; only ever called with `shares == 0` here.


```solidity
function convertToAssets(uint256 shares) external pure returns (uint256);
```

