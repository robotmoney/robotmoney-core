# Issue — KEEPER_ROLE exists in the vault but is not granted; autonomous rebalancing is blocked

> Summary: `RobotMoneyVault` defines a `KEEPER_ROLE` that allows calling `rebalance()` without `ADMIN_ROLE`. The constructor intentionally does not grant it ("KEEPER_ROLE intentionally NOT granted" — source comment). Phase 5 of the roadmap requires "Agent executes autonomous three-bucket allocation" and "first weekly allocation vote with live vault rebalancing." Without KEEPER_ROLE granted to an autonomous agent (or a smart-contract keeper), `rebalance()` can only be called by the Safe multisig admin — defeating the autonomous operations goal. The CLI has no commands to grant, revoke, or query role membership.

## 1. Severity

**Medium.** The vault works correctly today — rebalancing can be done manually by the admin Safe. But Phase 5 autonomous operations are blocked until KEEPER_ROLE is granted to an automated caller. The longer this is deferred, the more the vault's equal-weight allocation drifts as yield rates diverge across Morpho, Aave, and Compound.

## 2. Background

Roadmap Phase 5:
> "Agent executes autonomous three-bucket allocation"
> "First weekly allocation vote with live vault rebalancing"
> "Daily portfolio updates and weekly allocation shortlists via RM Agent"

From `contracts/RobotMoneyVault.sol`:

```solidity
bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

// In constructor:
_grantRole(ADMIN_ROLE, _admin);
_grantRole(EMERGENCY_ROLE, _admin);
// KEEPER_ROLE intentionally NOT granted
```

`rebalance()` accepts either ADMIN or KEEPER:

```solidity
function rebalance() external nonReentrant {
    if (!hasRole(ADMIN_ROLE, msg.sender) && !hasRole(KEEPER_ROLE, msg.sender)) {
        revert UnauthorizedRebalancer();
    }
    if (block.timestamp < lastRebalanceAt + minRebalanceInterval) revert RebalanceTooSoon();
    ...
}
```

Throttled by `minRebalanceInterval` (initial: 12 hours) and `maxRebalanceBpsPerCall` (initial: 25%). The throttle means a keeper can at most move 25% of TVL per call, no more frequently than every 12 hours — safe defaults.

## 3. What needs to happen

**3.1 Grant KEEPER_ROLE to an autonomous caller**

Options in order of increasing decentralisation:
- An EOA controlled by the RM agent (simplest, most fragile)
- The `@robotmoney/cli` OWS wallet running on the Moltbook harness
- A smart-contract keeper (Gelato, Chainlink Automation, or a custom on-chain scheduler)

Granting via the Safe multisig: `vault.grantRole(KEEPER_ROLE, <keeper_address>)`.

**3.2 CLI support for rebalance operations**

The CLI has no `rebalance` command. SKILL.md has no mention of rebalancing. At minimum, agents running Phase 5 operations need:
- `get-vault --verbose` to expose `isRebalanceAvailable()` and `nextRebalanceAt()` (both exist in the contract, neither in the CLI ABI — see §5)
- An `execute-rebalance` or `trigger-rebalance` command that calls `vault.rebalance()`
- SKILL.md guidance on when to trigger a rebalance (e.g. "after an allocation vote finalises weights")

**3.3 Rebalance throttle parameters**

Current values (`maxRebalanceBpsPerCall = 2500`, `minRebalanceInterval = 12 hours`) are conservative. For a weekly allocation cycle, 12 hours allows at most ~14 rebalance calls per week. At 25% per call, fully rebalancing from one extreme to equal weight takes ~4 calls (~2 days). Evaluate whether these are appropriate for Phase 5 or need tuning via `setMaxRebalanceBpsPerCall` / `setMinRebalanceInterval`.

## 4. Acceptance criteria

- KEEPER_ROLE is granted to a documented address (keeper EOA, smart contract, or agent wallet) via the admin Safe, with the grant transaction recorded on BaseScan.
- CLI exposes `isRebalanceAvailable()` and `nextRebalanceAt()` in `get-vault` (or a new `get-vault-rebalance-status` command).
- CLI ABI includes `rebalance()` and emits the `Rebalanced` event.
- SKILL.md documents when and how an agent should trigger `rebalance()`.
- A fork test asserts that an address with KEEPER_ROLE can call `rebalance()` and one without cannot.

## 5. CLI ABI gap (blocking)

These contract functions exist but are absent from `packages/cli/src/lib/abi.ts`:

| Function | Returns | Why it matters |
|---|---|---|
| `rebalance()` | — | KEEPER_ROLE callable |
| `isRebalanceAvailable()` | `bool` | Agent pre-check before calling |
| `nextRebalanceAt()` | `uint256` | Agent scheduling |
| `getAdapterDrift()` | `(uint256[], uint256[], int256[])` | Shows which adapters are over/under target |

See also `issue-vault-abi-incomplete.md`.

## 6. References

- Roadmap Phase 5: https://www.robotmoney.net/changelog
- Vault source: [`../../contracts/RobotMoneyVault.sol`](../../contracts/RobotMoneyVault.sol) `rebalance()`, `KEEPER_ROLE`
- Related: [`issue-vault-abi-incomplete.md`](issue-vault-abi-incomplete.md)
