# _ISafeSetup
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/test/SafeIntegration.t.sol)

Used only to generate the `setup(...)` calldata for SafeProxyFactory.
Not imported from a Safe library to keep the test self-contained.


## Functions
### setup


```solidity
function setup(
    address[] calldata _owners,
    uint256 _threshold,
    address to,
    bytes calldata data,
    address fallbackHandler,
    address paymentToken,
    uint256 payment,
    address payable paymentReceiver
) external;
```

