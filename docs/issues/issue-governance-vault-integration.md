# Issue — Governance votes have no on-chain path to vault rebalancing; allocation changes require admin Safe

> Summary: The roadmap (Phase 5) requires "first weekly allocation vote with live vault rebalancing." Phase 7 specifies "migration to on-chain gauge controller with veRM locking." The deployed vault has no governance integration — it cannot read $ROBOTMONEY token balances, does not accept votes, and has no mechanism to translate a vote outcome into an `adminRebalance()` or adapter change call. All weight changes currently require a Safe multisig transaction. The vote → rebalance chain is entirely manual and off-chain.

## 1. Severity

**Medium for Phase 4; High for Phase 5.** Phase 4 is the vault deployment and it is correctly scoped to Bucket A only. Phase 5 explicitly adds governance-driven rebalancing. Without this, Phase 5 cannot be declared complete.

## 2. Background

Roadmap Phase 5:
> "First weekly allocation vote with live vault rebalancing"
> "Default allocation behavior when quorum unmet"

Roadmap Phase 7:
> "Migration to on-chain gauge controller with veRM locking"
> "Flash loan attack elimination via vote-escrow requirements"
> "Bribe market infrastructure enabling agent payment for allocation weight"

### Current state from contracts

`RobotMoneyVault` has three rebalance entry points:

| Function | Caller | Governance-driven? |
|---|---|---|
| `rebalance()` | ADMIN or KEEPER | No — equal-weight across active adapters only |
| `adminRebalance(uint256[] targetBalances)` | ADMIN only | No — explicit Safe txn required |
| `addAdapter` / `removeAdapter` / `setAdapterCap` | ADMIN only | No — Safe txn required |

There is no function that accepts a governance vote result as input and executes the corresponding rebalance or allocation change.

The `$ROBOTMONEY` token (`0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` — also in the basket as ROBOT) exists on Base, but the vault has no reference to it, no `balanceOf` call, and no voting weight calculation.

## 3. What integration requires

Phase 5 (off-chain voting → multisig execution, pragmatic):
- Governance vote results are published off-chain (Snapshot or similar)
- The admin Safe executes `adminRebalance()` or `addAdapter/removeAdapter` based on the vote
- This is the minimum viable governance loop — manual but transparent if vote results are published on-chain or in a verifiable off-chain record

Phase 7 (on-chain gauge controller, full decentralisation):
- A new `GovernanceController` contract holds vote state, accepts `$ROBOTMONEY` or `veRM` weighted votes, and after a voting period calls `vault.adminRebalance()` via a role granted to the controller
- `veRM` token (vote-escrowed $ROBOTMONEY) prevents flash loan voting attacks
- The vault's `ADMIN_ROLE` would be shared with (or migrated to) the governance controller

**The vault contract is already structured for this.** `adminRebalance()` accepts a `uint256[]` of target balances — this is exactly what a governance controller would compute and pass. The vault does not need to be changed for Phase 5's off-chain-vote-to-multisig-execution flow. A new `GovernanceController` is only needed for Phase 7.

## 4. CLI gap

The CLI has no command that exposes the vote → rebalance flow to an agent. SKILL.md does not mention governance, votes, or rebalancing. When Phase 5 ships:

- `get-governance` (see `issue-get-governance-missing.md`) must return the current vote state
- A new `check-rebalance` or `get-vault --verbose` must expose `isRebalanceAvailable()`, `nextRebalanceAt()`, `getAdapterDrift()`
- SKILL.md must document: "after a governance vote finalises, the admin executes `adminRebalance`; the agent can observe the result via `get-vault --verbose`"

## 5. Acceptance criteria

**Phase 5 minimum:**
- A documented off-chain governance process (Snapshot or equivalent) with vote results published and verifiable.
- Each allocation change maps to a specific `adminRebalance()` or adapter management Safe transaction, with the txn hash recorded in a public changelog.
- CLI `get-governance` returns current bucket weights and when the last vote was executed.

**Phase 7 full:**
- `GovernanceController` contract deployed, holding `ADMIN_ROLE` for allocation changes.
- `veRM` locking contract deployed and integrated.
- `vault.grantRole(ADMIN_ROLE, governanceController)` executed via Safe.
- The Safe retains `EMERGENCY_ROLE` for pause/shutdown only.

## 6. References

- Roadmap Phase 5, Phase 7: https://www.robotmoney.net/changelog
- Vault rebalance surface: [`../../contracts/RobotMoneyVault.sol`](../../contracts/RobotMoneyVault.sol) `rebalance()`, `adminRebalance()`
- ROBOT token address (basket): [`../../packages/cli/src/lib/basket/constants.ts`](../../packages/cli/src/lib/basket/constants.ts)
- Related: [`issue-keeper-role-not-granted.md`](issue-keeper-role-not-granted.md), [`issue-bucket-b-c-not-implemented.md`](issue-bucket-b-c-not-implemented.md), [`issue-get-governance-missing.md`](issue-get-governance-missing.md)
