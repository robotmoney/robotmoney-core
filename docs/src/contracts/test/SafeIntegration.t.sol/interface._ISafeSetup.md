# _ISafeSetup
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75c9d821b281975c99c1bcf5090a766acfe071b0/contracts/test/SafeIntegration.t.sol)

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

