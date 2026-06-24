# MockGateway
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/test/InvestmentCommitteePolicy.t.sol)

Thin stub that forwards `submitVote` calls as if they came from a
real RobotMoneyGateway.  The real gateway enforces per-agent policy
caps; for this test we only care about the IC contract's own guards.


## State Variables
### ic

```solidity
InvestmentCommitteePolicy public ic
```


## Functions
### setIC


```solidity
function setIC(InvestmentCommitteePolicy ic_) external;
```

### callSubmitVote


```solidity
function callSubmitVote(InvestmentCommitteePolicy.VoteParams calldata p)
    external
    returns (uint256 voteId);
```

