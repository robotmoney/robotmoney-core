# MockGateway
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5f3ed0a39e045bd3fe3f3f4a024d482bf1b89ff8/contracts/test/InvestmentCommitteePolicy.t.sol)

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

