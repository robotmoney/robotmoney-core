# Deposit gas floors (core 1777)

Companion to `docs/technical/redeem-gas-1482.md`. That document explains why each entrypoint checks one gas floor at entry. This one lists the deposit floors that integrators and the dapp must meet.

## Minimums
| Entrypoint | Floor | Where | Limit the clients send |
|---|---|---|---|
| `RobotMoneyVault.deposit` and `mint` (rmUSDC) | 1,600,000 | `DEPOSIT_ENTRY_GAS_FLOOR` in `contracts/RobotMoneyVault.sol` | 2,500,000 |
| `PortfolioRouter.deposit` and `depositFor` | `legs * 1,700,000`, so 6,800,000 for the 4-leg router | `DEPOSIT_GAS_PER_LEG` in `contracts/PortfolioRouter.sol` | `legs * 1,700,000 + 1,200,000`, so 8,000,000 for 4 legs |

`legs` is the length of the effective weight vector. Legs that are later skipped still count, so the floor is an upper bound. A router with fewer or more weighted vaults has a floor of `legs * 1,700,000`.

## Why
Each entrypoint reverts `InsufficientGas(available, required)` when `gasleft()` is below the floor at entry. The check runs before any state-dependent work. That makes the node estimate land on the floor in every state (see the redeem document). A limit that is too low fails with a typed error instead of an empty revert.

The check reads `gasleft()` after the transaction's intrinsic cost and the code before the check are paid. A transaction limit equal to the floor therefore still fails. Send a limit above the floor.

## Evidence
- Router: `InsufficientGas(5948330, 6800000)` at a 6,000,000 limit on Base (devops run 2, router 1 USDC deposit). Successful router deposit `0x346dd34f429ebe957a549789b9d6a6738f6a1eaba9051b60097ed9037ef3e845` with an 8M limit.
- Vault: a direct rmUSDC deposit reverted `InsufficientGas` at a 1,500,000 limit. The vault requires 1,600,000 at entry (`PULL_ENTRY_GAS_FLOOR` has the same value for redeem and withdraw). The harness now sends 2,500,000 for vault deposits and 8,000,000 for router deposits.
- The 1,600,000 vault floor is confirmed by the contract constant and by the fork test below. The 6,800,000 router floor is `4 * DEPOSIT_GAS_PER_LEG`.

## Who must comply
- **Dapp:** `clients/dapp/src/lib/depositGas.ts` sets the limit on every deposit write. Router deposits send `legs * 1,700,000 + 1,200,000` from the effective leg count (8,000,000 for 4 legs, 9,700,000 for 5). Vault deposits send 2,500,000. Unused gas is refunded.
- **rmpc:** `rmpc deposit --destination <router>` reads `router.getEffectiveWeights()` and sends the gateway floor (400,000 + 1,850,000 per leg) plus 150,000. It refuses a `--gas-limit` below the floor with `ErrGasLimitBelowFloor` before signing. The vault path sends 3,000,000 (gateway floor 2,000,000).
- **Gateway callers and other integrators:** the gateway has its own floors (`docs/technical/redeem-gas-1482.md`, Deposit paths). A direct call to the router or a vault must set `gas` explicitly. Do not rely on a wallet estimate, since it can land below the floor in another block state.

## Tests
- **Fork** (`contracts/test/CoreStagesFork.t.sol`, job `forge-fork-vault-regressions`):
  - `test_fork_routerDeposit_below6p8M_revertsInsufficientGasWithTheFloor`: a 4-leg router at 6M reverts `InsufficientGas` with required 6,800,000.
  - `test_fork_routerDeposit_at8M_succeeds`: the same router at 8M mints four legs.
  - `test_fork_vaultDeposit_below1p6M_revertsInsufficientGasWithTheFloor`: rmUSDC at 1.5M reverts with required 1,600,000.
  - `test_fork_vaultDeposit_at2p5M_succeeds`: rmUSDC at 2.5M mints shares.
- **Dapp unit** (`clients/dapp/tests/unit/deposit-gas.test.ts`): the limits are above the floors and each deposit tab sends them.
