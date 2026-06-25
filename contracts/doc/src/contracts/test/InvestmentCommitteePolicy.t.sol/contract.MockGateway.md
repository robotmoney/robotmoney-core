# MockGateway
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/test/InvestmentCommitteePolicy.t.sol)

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

