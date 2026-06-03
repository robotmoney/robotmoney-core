# _ISafeSetup
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e1a131c0c2ecf9334ca951298cb03794be5b1ef2/contracts/test/SafeIntegration.t.sol)

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

