# BpsMath
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/lib/BpsMath.sol)

**Title:**
BpsMath

Single canonical basis-points denominator for the protocol. Fee,
slippage, weight, and allocation-cap math across the vaults and the
router previously each redefined the value 10000 under drifting
names (`BPS_DENOMINATOR`, `MAX_BPS`), types (`uint16`, `uint256`),
and literal styles (`10000`, `10_000`). Consolidating the value here
removes the divergence risk flagged by the 2026-06-18 holistic
review while preserving each call site's existing arithmetic type:
consumers reference `BpsMath.BPS_DENOMINATOR` and apply their own
narrowing cast (e.g. `uint16(BpsMath.BPS_DENOMINATOR)`) where a
narrower public constant type must be retained for storage/ABI
compatibility.


## Constants
### BPS_DENOMINATOR
The basis-points denominator: 100% expressed in basis points.
One basis point is 1/10000. All fee, slippage, weight, and cap
percentages in the protocol are expressed as a numerator over
this denominator.


```solidity
uint256 internal constant BPS_DENOMINATOR = 10_000
```


